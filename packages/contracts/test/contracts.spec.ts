import { describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  CreateJobRequest,
  ResultFilter,
  buildOpenApiDocument,
  buildPath,
  resultFilterFromQuery,
  resultFilterToQuery,
  routes,
  ResultQuery,
  type ResultFilter as ResultFilterInput,
} from '../src/index.js';

describe('OpenAPI document', () => {
  const doc = buildOpenApiDocument() as {
    paths: Record<string, Record<string, { operationId: string; requestBody?: unknown }>>;
    components: { schemas: Record<string, unknown> };
  };

  it('has one operation per route with a unique operationId', () => {
    const ops = Object.values(doc.paths).flatMap((methods) => Object.values(methods).map((op) => op.operationId));
    expect(ops.sort()).toEqual(Object.keys(routes).sort());
  });

  it('only references components that exist', () => {
    const refs = JSON.stringify(doc).match(/#\/components\/schemas\/[A-Za-z0-9_]+/g) ?? [];
    for (const ref of new Set(refs)) {
      expect(doc.components.schemas[ref.split('/').pop()!], ref).toBeDefined();
    }
  });

  it('uses the input form for request bodies with defaults', () => {
    const body = doc.paths[`${API_PREFIX}/jobs`]!.post!.requestBody as { content: Record<string, { schema: { $ref: string } }> };
    expect(body.content['application/json']!.schema.$ref).toBe('#/components/schemas/CreateJobRequestInput');
  });
});

describe('result filter', () => {
  it('round-trips through the query-string form', () => {
    const filter: ResultFilterInput = { q: 'acme', outcomes: ['no_record', 'registered'], suffixes: ['com', 'co.uk'], resolved: false, sort: 'price', order: 'desc' };
    const query = ResultQuery.parse(resultFilterToQuery(filter));
    expect(resultFilterFromQuery(query)).toEqual(ResultFilter.parse(filter));
  });
});

describe('requests', () => {
  it('applies scan defaults', () => {
    const parsed = CreateJobRequest.parse({ type: 'registry_scan', input: { text: 'acme' } });
    expect(parsed).toMatchObject({ recheck: false, input: { format: 'auto', extensions: [] } });
  });

  it('fills path parameters', () => {
    expect(buildPath(routes.getJob.path, { id: 'abc' })).toBe('/jobs/abc');
    expect(() => buildPath(routes.getJob.path, {})).toThrow();
  });
});
