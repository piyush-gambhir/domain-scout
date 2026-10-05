import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Bundled registry metadata in apps/backend/data/registry. The path is resolved from this module
 * so it works from both src (tests) and dist (compiled backend); dist/registry and src/registry are
 * both two levels below apps/backend.
 */
export const REGISTRY_DATA_DIR = fileURLToPath(new URL('../../data/registry/', import.meta.url));

function load<T extends z.ZodType>(file: string, schema: T): z.output<T> {
  const text = readFileSync(`${REGISTRY_DATA_DIR}${file}`, 'utf8');
  return schema.parse(JSON.parse(text));
}

/** IANA RDAP bootstrap for DNS (RFC 9224): `services` is a list of [suffixes, base URLs]. */
export const BootstrapJson = z.object({
  version: z.string().optional(),
  publication: z.string(),
  description: z.string().optional(),
  services: z.array(z.tuple([z.array(z.string()), z.array(z.string())]).rest(z.unknown())),
});
export type BootstrapJson = z.infer<typeof BootstrapJson>;

export const BootstrapSnapshot = z.object({
  source: z.string(),
  fetchedAt: z.string(),
  lastModified: z.string().nullable().optional(),
  note: z.string().optional(),
  bootstrap: BootstrapJson,
});
export type BootstrapSnapshot = z.infer<typeof BootstrapSnapshot>;

export const RootTldList = z.object({
  source: z.string(),
  fetchedAt: z.string(),
  version: z.string(),
  lastUpdated: z.string(),
  count: z.number(),
  tlds: z.array(z.string()),
});
export type RootTldList = z.infer<typeof RootTldList>;

export const WhoisRouteSpec = z.object({
  tld: z.string(),
  host: z.string(),
  port: z.number().int().default(43),
  query: z.string().includes('{domain}'),
  parser: z.string(),
  registryId: z.string(),
  source: z.string(),
  verifiedAt: z.string(),
  rateLimitCooldownSeconds: z.number().int().min(1),
  notes: z.string().optional(),
});
export type WhoisRouteSpec = z.infer<typeof WhoisRouteSpec>;

export const WhoisRouting = z.object({
  updatedAt: z.string(),
  routes: z.array(WhoisRouteSpec),
  withoutClassifier: z.array(
    z.object({ tld: z.string(), host: z.string().nullable(), source: z.string(), reason: z.string() }),
  ),
});
export type WhoisRouting = z.infer<typeof WhoisRouting>;

export const RegistryOperators = z.object({
  registries: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      rdapHosts: z.array(z.string()),
      whoisHosts: z.array(z.string()),
      source: z.string(),
    }),
  ),
});
export type RegistryOperators = z.infer<typeof RegistryOperators>;

export const BuiltInPresets = z.object({
  presets: z.array(z.object({ id: z.string(), name: z.string(), extensions: z.array(z.string()).min(1) })),
});

export const FixtureKind = z.enum(['captured_live', 'reconstructed']);

/** Which suffixes have classifier fixtures (checked against test/fixtures/registry by a unit test). */
export const FixtureManifest = z.object({
  fixtures: z.array(
    z.object({
      file: z.string(),
      suffix: z.string().nullable(),
      protocol: z.enum(['rdap', 'whois']),
      kind: FixtureKind,
      expected: z.string(),
    }),
  ),
});
export type FixtureManifest = z.infer<typeof FixtureManifest>;

export const LiveValidationResult = z.object({
  domain: z.string(),
  suffix: z.string(),
  protocol: z.enum(['rdap', 'whois']),
  destination: z.string(),
  expected: z.string(),
  observed: z.string(),
  at: z.string(),
  httpStatus: z.number().int().nullable(),
  reason: z.string(),
});
export type LiveValidationResult = z.infer<typeof LiveValidationResult>;

export const LiveValidation = z.object({
  description: z.string().optional(),
  results: z.array(LiveValidationResult),
  notRun: z.array(z.object({ suffix: z.string(), destination: z.string(), reason: z.string(), at: z.string() })),
});
export type LiveValidation = z.infer<typeof LiveValidation>;

export interface RegistryData {
  bootstrap: BootstrapSnapshot;
  rootTlds: RootTldList;
  whois: WhoisRouting;
  operators: RegistryOperators;
  presets: z.infer<typeof BuiltInPresets>['presets'];
  fixtures: FixtureManifest;
  liveValidation: LiveValidation;
}

let cached: RegistryData | null = null;

/** Loads and validates every bundled file once per process. */
export function loadRegistryData(): RegistryData {
  cached ??= {
    bootstrap: load('rdap-bootstrap.json', BootstrapSnapshot),
    rootTlds: load('iana-tlds.json', RootTldList),
    whois: load('whois-routing.json', WhoisRouting),
    operators: load('registries.json', RegistryOperators),
    presets: load('presets.json', BuiltInPresets).presets,
    fixtures: load('fixture-manifest.json', FixtureManifest),
    liveValidation: load('live-validation.json', LiveValidation),
  };
  return cached;
}
