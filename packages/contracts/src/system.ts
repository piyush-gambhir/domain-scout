import { z } from 'zod';
import { CurrencyCode, Suffix, Timestamp, Uuid, envelope, page } from './common.js';
import { FxRate, Offer } from './pricing.js';
import { Resolver, Diagnostic, NameCheck, AftermarketListing } from './enrichment.js';
import { RegistryObservation } from './registry.js';
import { ProviderConfirmation, ProviderReadiness } from './providers.js';
import { JobOrigin, JobType } from './jobs.js';

export const Health = z
  .object({
    status: z.literal('ok'),
    instanceId: Uuid,
    protocolVersion: z.number().int(),
    contractVersion: z.string(),
    version: z.string(),
    startedAt: Timestamp,
    pid: z.number().int(),
    dataDir: z.string(),
  })
  .meta({ id: 'Health' });
export type Health = z.infer<typeof Health>;
export const HealthResponse = envelope(Health, 'HealthResponse');

export const Capabilities = z
  .object({
    contractVersion: z.string(),
    registry: z.object({
      tested: z.number().int(),
      discovered: z.number().int(),
      unsupported: z.number().int(),
      protocols: z.array(z.string()),
    }),
    providers: z.array(z.object({ id: z.string(), name: z.string(), readiness: ProviderReadiness })),
    jobTypes: z.array(JobType),
    nameCheckServices: z.array(z.string()),
    diagnostics: z.array(z.string()),
    exportFormats: z.array(z.string()),
    mcp: z.boolean(),
  })
  .meta({ id: 'Capabilities' });
export const CapabilitiesResponse = envelope(Capabilities, 'CapabilitiesResponse');

export const Settings = z
  .object({
    concurrency: z.object({
      global: z.number().int().min(1).max(64),
      perSource: z.number().int().min(1).max(8),
      minSourceIntervalMs: z.number().int().min(0).max(60_000),
      maxCooldownWaitSeconds: z.number().int().min(0).max(86_400),
    }),
    retries: z.object({ maxAttempts: z.number().int().min(1).max(5), timeoutMs: z.number().int().min(1000).max(120_000) }),
    freshness: z.object({
      registryMinutes: z.number().int().min(1),
      catalogHours: z.number().int().min(1),
      quoteMinutes: z.number().int().min(1),
    }),
    monitoring: z.object({ defaultIntervalMinutes: z.number().int().min(15) }),
    comparison: z.object({ horizonYears: z.number().int().min(1).max(10), currency: CurrencyCode.nullable() }),
    diagnostics: z.object({ resolver: Resolver }),
    privacy: z.object({
      keepRawDiagnostics: z.boolean().meta({ description: 'Store sanitized raw registry responses for inspection' }),
    }),
    fxRates: z.array(FxRate),
    appearance: z.object({ theme: z.enum(['system', 'light', 'dark']) }),
    search: z.object({
      defaultExtensions: z.array(Suffix).min(1).max(50).meta({ description: 'Extensions a new UI search starts with' }),
    }),
  })
  .meta({ id: 'Settings' });
export type Settings = z.infer<typeof Settings>;
export const SettingsResponse = envelope(Settings, 'SettingsResponse');

export const SettingsPatch = z
  .object({
    concurrency: Settings.shape.concurrency.partial().optional(),
    retries: Settings.shape.retries.partial().optional(),
    freshness: Settings.shape.freshness.partial().optional(),
    monitoring: Settings.shape.monitoring.partial().optional(),
    comparison: Settings.shape.comparison.partial().optional(),
    diagnostics: Settings.shape.diagnostics.partial().optional(),
    privacy: Settings.shape.privacy.partial().optional(),
    fxRates: z.array(FxRate).optional(),
    appearance: Settings.shape.appearance.partial().optional(),
    search: Settings.shape.search.partial().optional(),
  })
  .meta({ id: 'SettingsPatch' });

export const DEFAULT_SETTINGS: Settings = {
  concurrency: { global: 16, perSource: 1, minSourceIntervalMs: 1000, maxCooldownWaitSeconds: 300 },
  retries: { maxAttempts: 3, timeoutMs: 15_000 },
  freshness: { registryMinutes: 15, catalogHours: 24, quoteMinutes: 15 },
  monitoring: { defaultIntervalMinutes: 1440 },
  comparison: { horizonYears: 3, currency: null },
  diagnostics: { resolver: 'system' },
  privacy: { keepRawDiagnostics: false },
  fxRates: [],
  appearance: { theme: 'system' },
  search: { defaultExtensions: ['com', 'io', 'dev', 'app', 'co', 'ai'] },
};

/* Session bootstrap for the browser. */

export const BootstrapCode = z
  .object({ code: z.string(), expiresAt: Timestamp })
  .meta({ id: 'BootstrapCode' });
export const BootstrapCodeResponse = envelope(BootstrapCode, 'BootstrapCodeResponse');
export const SessionExchange = z.object({ code: z.string().min(16) }).meta({ id: 'SessionExchange' });
export const SessionInfo = z
  .object({ sessionId: z.string(), csrfToken: z.string(), expiresAt: Timestamp })
  .meta({ id: 'SessionInfo' });
export const SessionInfoResponse = envelope(SessionInfo, 'SessionInfoResponse');
/** What a browser may learn about its own session: never the session id behind the HttpOnly cookie. */
export const SessionStatus = z
  .object({ csrfToken: z.string(), expiresAt: Timestamp })
  .meta({ id: 'SessionStatus' });
export const SessionStatusResponse = envelope(SessionStatus, 'SessionStatusResponse');

/* Domain evidence and history. */

export const DomainEvidence = z
  .object({
    domain: z.string(),
    unicode: z.string(),
    suffix: z.string(),
    registry: z.array(RegistryObservation).meta({ description: 'Newest first; older evidence stays identifiable' }),
    confirmations: z.array(ProviderConfirmation),
    offers: z.array(Offer),
    nameChecks: z.array(NameCheck),
    diagnostics: z.array(Diagnostic),
    listings: z.array(AftermarketListing),
    collections: z.array(z.object({ id: Uuid, name: z.string(), notes: z.string().nullable() })),
    providers: z
      .array(
        z.object({
          providerId: z.string(),
          name: z.string(),
          supportsSuffix: z.enum(['yes', 'no', 'unknown']),
          purchaseUrl: z.string().nullable(),
          purchaseKind: z.enum(['search', 'dashboard', 'website']).nullable(),
          enabled: z.boolean(),
          preferred: z.boolean(),
        }),
      )
      .meta({ description: 'Providers and matching purchase destinations for this suffix' }),
  })
  .meta({ id: 'DomainEvidence' });
export type DomainEvidence = z.infer<typeof DomainEvidence>;
export const DomainEvidenceResponse = envelope(DomainEvidence, 'DomainEvidenceResponse');

export const RawDiagnostic = z
  .object({ observationId: Uuid, contentType: z.string().nullable(), body: z.string(), truncated: z.boolean() })
  .meta({ id: 'RawDiagnostic', description: 'Sanitized raw source response, stored only when enabled' });
export const RawDiagnosticResponse = envelope(RawDiagnostic, 'RawDiagnosticResponse');

export const HistoryEntry = z
  .object({
    jobId: Uuid,
    type: JobType,
    origin: JobOrigin,
    label: z.string().nullable(),
    state: z.string(),
    createdAt: Timestamp,
    finishedAt: Timestamp.nullable(),
    total: z.number().int(),
    unresolved: z.number().int(),
    extensions: z.array(z.string()),
    destinations: z.array(z.string()).meta({ description: 'External destinations the job contacts' }),
    resumable: z.boolean(),
  })
  .meta({ id: 'HistoryEntry' });
export const HistoryListResponse = page(HistoryEntry, 'HistoryListResponse');

export const HistoryQuery = z.object({
  q: z.string().optional().meta({ description: 'Filter by label or domain' }),
  type: z.string().optional(),
  origins: z.string().optional().meta({ description: 'Comma-separated JobOrigin values, e.g. ui,cli' }),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const DataCategory = z
  .enum([
    'jobs',
    'registry_evidence',
    'provider_evidence',
    'price_history',
    'name_checks',
    'diagnostics',
    'raw_diagnostics',
    'collections',
    'criteria',
    'watches',
    'portfolio',
    'artifacts',
  ])
  .meta({ id: 'DataCategory' });
export type DataCategory = z.infer<typeof DataCategory>;

export const DataInventory = z
  .object({
    dataDir: z.string(),
    databaseBytes: z.number().int(),
    categories: z.array(z.object({ category: DataCategory, count: z.number().int() })),
  })
  .meta({ id: 'DataInventory' });
export const DataInventoryResponse = envelope(DataInventory, 'DataInventoryResponse');

export const DataDelete = z
  .object({
    categories: z.array(DataCategory).min(1),
    collectionIds: z.array(Uuid).optional().meta({ description: 'Limit collection deletion to these collections' }),
    before: Timestamp.optional(),
  })
  .meta({ id: 'DataDelete', description: 'Scoped deletion; unrelated records are preserved' });
export const DataDeleteResult = z
  .object({ deleted: z.array(z.object({ category: DataCategory, count: z.number().int() })) })
  .meta({ id: 'DataDeleteResult' });
export const DataDeleteResponse = envelope(DataDeleteResult, 'DataDeleteResponse');

export const ServiceStop = z
  .object({ stopping: z.literal(true), graceMs: z.number().int() })
  .meta({ id: 'ServiceStop' });
export const ServiceStopResponse = envelope(ServiceStop, 'ServiceStopResponse');

