import { z } from 'zod';
import { API_PREFIX, routes, type RouteDef } from './routes.js';
import { CONTRACT_VERSION } from './common.js';

type JsonSchema = Record<string, unknown>;
const REF_PREFIX = '#/components/schemas/';
const INPUT_SUFFIX = 'Input';

const TEMP_PREFIX = '__route_';

/** Registry holding every named schema plus the unnamed route parts under temporary ids. */
function routeRegistry() {
  const registry = z.registry<{ id?: string; description?: string }>();
  const named = (z.globalRegistry as unknown as { _idmap: Map<string, z.ZodType> })._idmap;
  for (const [, schema] of named) registry.add(schema, z.globalRegistry.get(schema) ?? {});
  for (const [operationId, def] of Object.entries(routes) as [string, RouteDef][]) {
    for (const part of ['params', 'query', 'body', 'response'] as const) {
      const schema = def[part];
      if (schema && !z.globalRegistry.get(schema)?.id && !registry.has(schema)) {
        registry.add(schema, { id: `${TEMP_PREFIX}${operationId}_${part}` });
      }
    }
  }
  return registry;
}

function stripClosedObjects(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripClosedObjects);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === 'additionalProperties' && v === false) continue;
      out[key] = stripClosedObjects(v);
    }
    return out;
  }
  return value;
}

function componentSchemas(registry: ReturnType<typeof routeRegistry>, io: 'input' | 'output', suffix: string) {
  const result = z.toJSONSchema(registry, {
    target: 'openapi-3.0',
    io,
    unrepresentable: 'any',
    uri: (id) => `${REF_PREFIX}${id}${suffix}`,
  }) as { schemas: Record<string, JsonSchema> };
  const out: Record<string, JsonSchema> = {};
  for (const [id, schema] of Object.entries(result.schemas)) {
    const { $schema: _ignored, $id: _id, ...rest } = schema;
    // Responses stay open to added fields; requests are validated by the backend.
    out[id] = stripClosedObjects(rest) as JsonSchema;
  }
  return out;
}

function refsOf(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => refsOf(v, found));
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === '$ref' && typeof v === 'string' && v.startsWith(REF_PREFIX)) found.add(v.slice(REF_PREFIX.length));
      else refsOf(v, found);
    }
  }
  return found;
}

function rewriteRefs(value: unknown, map: (name: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteRefs(v, map));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] =
        key === '$ref' && typeof v === 'string' && v.startsWith(REF_PREFIX)
          ? REF_PREFIX + map(v.slice(REF_PREFIX.length))
          : rewriteRefs(v, map);
    }
    return out;
  }
  return value;
}

/**
 * OpenAPI 3.0 `nullable` only applies when `type` is in the same schema object, so
 * `{ nullable: true, allOf: [$ref] }` does not admit null for a primitive component. Inline primitive
 * components (strings, numbers, enums) at nullable use sites. Nullable object references keep the
 * allOf form, which generators (oapi-codegen) map to pointers; the backend validates with Zod.
 */
function inlineNullablePrimitives(schemas: Record<string, JsonSchema>, refName: (name: string) => string = (n) => n) {
  const primitive = (name: string) => {
    const target = schemas[refName(name)] ?? schemas[name];
    return target && target.type !== undefined && target.type !== 'object' && !target.allOf && !target.oneOf ? target : null;
  };
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    const obj = node as JsonSchema;
    const allOf = obj.allOf as JsonSchema[] | undefined;
    if (obj.nullable === true && allOf?.length === 1 && typeof allOf[0]?.$ref === 'string') {
      const target = primitive((allOf[0].$ref as string).slice(REF_PREFIX.length));
      if (target) {
        const { allOf: _a, ...rest } = obj;
        return { ...target, ...rest, nullable: true };
      }
    }
    const out: JsonSchema = {};
    for (const [key, value] of Object.entries(obj)) out[key] = visit(value);
    return out;
  };
  for (const id of Object.keys(schemas)) schemas[id] = visit(schemas[id]) as JsonSchema;
}

/**
 * Request bodies use the schema input form (fields with defaults are optional), responses use the
 * output form. An `XInput` component is emitted only where the two forms differ.
 */
function buildSchemas() {
  const registry = routeRegistry();
  const output = componentSchemas(registry, 'output', '');
  const input = componentSchemas(registry, 'input', INPUT_SUFFIX);
  const strip = (name: string) => (name.endsWith(INPUT_SUFFIX) ? name.slice(0, -INPUT_SUFFIX.length) : name);

  const differs = new Set<string>();
  for (const id of Object.keys(input)) {
    if (JSON.stringify(rewriteRefs(input[id], strip)) !== JSON.stringify(output[id])) differs.add(id);
  }
  // A schema also differs when anything it references differs.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of Object.keys(input)) {
      if (differs.has(id)) continue;
      if ([...refsOf(input[id])].some((ref) => differs.has(strip(ref)))) {
        differs.add(id);
        changed = true;
      }
    }
  }

  inlineNullablePrimitives(output);
  inlineNullablePrimitives(input, strip);

  const inputName = (id: string) => (differs.has(id) ? `${id}${INPUT_SUFFIX}` : id);
  const inputSchema = (id: string) => rewriteRefs(input[id], (name) => inputName(strip(name))) as JsonSchema;
  const components: Record<string, unknown> = {};
  for (const id of Object.keys(output)) {
    if (id.startsWith(TEMP_PREFIX)) continue;
    components[id] = output[id];
    if (differs.has(id)) components[`${id}${INPUT_SUFFIX}`] = inputSchema(id);
  }

  /** Schema for a route part: a $ref for named schemas, the inline schema otherwise. */
  const schemaFor = (schema: z.ZodType, io: 'input' | 'output'): JsonSchema => {
    const id = registry.get(schema)?.id as string;
    if (!id.startsWith(TEMP_PREFIX)) return { $ref: REF_PREFIX + (io === 'input' ? inputName(id) : id) };
    return io === 'input' ? inputSchema(id) : (output[id] as JsonSchema);
  };
  return { components, schemaFor };
}

function parameters(def: RouteDef, schemaFor: ReturnType<typeof buildSchemas>['schemaFor']) {
  const params: unknown[] = [];
  for (const [location, schema] of [
    ['path', def.params],
    ['query', def.query],
  ] as const) {
    if (!schema) continue;
    const json = schemaFor(schema, 'input') as { properties?: Record<string, JsonSchema>; required?: string[] };
    for (const [name, prop] of Object.entries(json.properties ?? {})) {
      const { description, ...propSchema } = prop as JsonSchema & { description?: string };
      params.push({
        name,
        in: location,
        required: location === 'path' ? true : (json.required ?? []).includes(name) && !('default' in propSchema),
        ...(description ? { description } : {}),
        schema: propSchema,
      });
    }
  }
  if (def.idempotent) {
    params.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description: 'Replaying the same key and body returns the original job; a different body returns 409',
      schema: { type: 'string', maxLength: 200 },
    });
  }
  return params;
}

export function buildOpenApiDocument() {
  const { components, schemaFor } = buildSchemas();
  const paths: Record<string, Record<string, unknown>> = {};
  const errorRef = { $ref: `${REF_PREFIX}ErrorResponse` };
  const errorResponses = {
    '400': { description: 'Invalid request', content: { 'application/json': { schema: errorRef } } },
    '401': { description: 'Local authorization failed', content: { 'application/json': { schema: errorRef } } },
    '404': { description: 'Local resource not found', content: { 'application/json': { schema: errorRef } } },
    '409': { description: 'Conflicting state or idempotency key reuse', content: { 'application/json': { schema: errorRef } } },
    '503': { description: 'Local execution temporarily unavailable', content: { 'application/json': { schema: errorRef } } },
  };

  for (const [operationId, def] of Object.entries(routes) as [string, RouteDef][]) {
    const openApiPath = API_PREFIX + def.path.replace(/:([A-Za-z]+)/g, '{$1}');
    const contentType =
      def.produces === 'sse' ? 'text/event-stream' : def.produces === 'file' ? 'application/octet-stream' : 'application/json';
    const operation: Record<string, unknown> = {
      operationId,
      summary: def.summary,
      tags: [def.tag],
      parameters: parameters(def, schemaFor),
      responses: {
        [String(def.status ?? 200)]: {
          description: def.summary,
          content: { [contentType]: { schema: schemaFor(def.response, 'output') } },
        },
        ...errorResponses,
      },
    };
    if (def.auth === 'none') operation.security = [];
    if (def.external) operation['x-external'] = true;
    if (def.body) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: schemaFor(def.body, 'input') } },
      };
    }
    (paths[openApiPath] ??= {})[def.method] = operation;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Domain Scout local API',
      version: CONTRACT_VERSION,
      description:
        'Local-only API served by the Domain Scout backend on the loopback interface. Registry results never claim registration eligibility; see each schema for semantics.',
    },
    servers: [{ url: 'http://127.0.0.1:4317' }],
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    paths,
    components: {
      schemas: components,
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Local API token from the owner-only token file' },
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'ds_session', description: 'Browser session created by the launcher exchange' },
      },
    },
  };
}
