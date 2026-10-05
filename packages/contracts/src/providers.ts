import { z } from 'zod';
import { AsciiDomain, Freshness, Reason, Suffix, Timestamp, Uuid, envelope, page } from './common.js';

export const ProviderId = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .meta({ id: 'ProviderId', description: 'Provider identifier, e.g. porkbun, hostinger, register-si' });

export const ProviderKind = z
  .enum(['registrar', 'directory'])
  .meta({ id: 'ProviderKind', description: 'directory entries come from registry-published registrar lists' });

export const CapabilityLevel = z
  .enum(['unsupported', 'documented', 'fixture_tested', 'live_tested'])
  .meta({
    id: 'CapabilityLevel',
    description:
      'documented: implemented from official documentation without fixtures; fixture_tested: covered by sanitized fixtures; live_tested: exercised against the real service',
  });
export type CapabilityLevel = z.infer<typeof CapabilityLevel>;

export const CapabilityName = z
  .enum(['purchaseLink', 'catalog', 'exactCheck', 'quote', 'transfer', 'aftermarket'])
  .meta({ id: 'CapabilityName' });
export type CapabilityName = z.infer<typeof CapabilityName>;

export const Capability = z
  .object({
    level: CapabilityLevel,
    requiresCredentials: z.boolean(),
    source: z.string().nullable().meta({ description: 'Official documentation URL for this capability' }),
    verifiedAt: Timestamp.nullable(),
    notes: z.string().nullable(),
  })
  .meta({ id: 'Capability' });
export type Capability = z.infer<typeof Capability>;

export const ProviderCapabilities = z
  .object({
    purchaseLink: Capability,
    catalog: Capability,
    exactCheck: Capability,
    quote: Capability,
    transfer: Capability,
    aftermarket: Capability,
  })
  .meta({ id: 'ProviderCapabilities' });
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>;

export const CredentialField = z
  .object({
    key: z.string(),
    label: z.string(),
    secret: z.boolean(),
    required: z.boolean(),
    help: z.string().nullable(),
    envVar: z.string().meta({ description: 'Environment variable that can supply this field' }),
  })
  .meta({ id: 'CredentialField' });
export type CredentialField = z.infer<typeof CredentialField>;

export const CredentialStorage = z
  .enum(['env', 'session', 'file'])
  .meta({
    id: 'CredentialStorage',
    description: 'env: environment variables; session: kept in memory until the backend stops; file: owner-only local credential file',
  });
export type CredentialStorage = z.infer<typeof CredentialStorage>;

export const CredentialTestResult = z
  .enum(['ok', 'failed', 'not_testable'])
  .meta({ id: 'CredentialTestResult' });

export const CredentialState = z
  .object({
    configured: z.boolean(),
    storage: CredentialStorage.nullable(),
    storageLocation: z.string().nullable().meta({ description: 'File path when storage is file' }),
    fields: z.array(z.object({ key: z.string(), set: z.boolean() })),
    lastTestedAt: Timestamp.nullable(),
    lastTestResult: CredentialTestResult.nullable(),
    lastTestMessage: z.string().nullable(),
  })
  .meta({ id: 'CredentialState', description: 'Never contains secret values' });
export type CredentialState = z.infer<typeof CredentialState>;

export const ProviderReadiness = z
  .enum(['ready', 'keyless', 'credentials_missing', 'credentials_invalid', 'disabled'])
  .meta({
    id: 'ProviderReadiness',
    description:
      'keyless: only keyless capabilities (links, public catalog) are active; credentials_missing: optional authenticated capabilities need setup',
  });
export type ProviderReadiness = z.infer<typeof ProviderReadiness>;

export const PurchaseLinkInfo = z
  .object({
    template: z.string().meta({ description: 'URL template with {domain} placeholder' }),
    kind: z.enum(['search', 'dashboard']).meta({ description: 'dashboard links need an account login' }),
    source: z.string(),
    verifiedAt: Timestamp.nullable(),
  })
  .meta({ id: 'PurchaseLinkInfo' });

export const CatalogState = z
  .object({
    suffixCount: z.number().int(),
    fetchedAt: Timestamp.nullable(),
    staleAt: Timestamp.nullable(),
    freshness: Freshness.nullable(),
    source: z.string().nullable(),
    lastError: Reason.nullable(),
  })
  .meta({ id: 'CatalogState' });

export const Provider = z
  .object({
    id: ProviderId,
    name: z.string(),
    kind: ProviderKind,
    website: z.string(),
    setupUrl: z.string().nullable(),
    suffixes: z.array(Suffix).nullable().meta({ description: 'Known supported suffixes; null when unknown without a catalog' }),
    enabled: z.boolean(),
    preferred: z.boolean(),
    capabilities: ProviderCapabilities,
    credentialFields: z.array(CredentialField),
    credentials: CredentialState,
    readiness: ProviderReadiness,
    catalog: CatalogState.nullable(),
    purchaseLink: PurchaseLinkInfo.nullable(),
    accountRequirements: z.array(z.string()),
    rateLimits: z.string().nullable(),
  })
  .meta({ id: 'Provider' });
export type Provider = z.infer<typeof Provider>;

export const ProviderListResponse = page(Provider, 'ProviderListResponse');
export const ProviderResponse = envelope(Provider, 'ProviderResponse');

export const ProviderPreferencesPatch = z
  .object({ enabled: z.boolean().optional(), preferred: z.boolean().optional() })
  .meta({ id: 'ProviderPreferencesPatch' });

export const CredentialsPut = z
  .object({
    values: z.record(z.string(), z.string().min(1).max(4096)),
    storage: z.enum(['session', 'file']).meta({ description: 'session keeps secrets in memory only; file writes the owner-only credential file' }),
  })
  .meta({ id: 'CredentialsPut' });

export const CredentialTest = z
  .object({
    result: CredentialTestResult,
    testedAt: Timestamp,
    operation: z.string().nullable().meta({ description: 'The non-candidate account operation used' }),
    message: z.string(),
  })
  .meta({ id: 'CredentialTest' });
export const CredentialTestResponse = envelope(CredentialTest, 'CredentialTestResponse');

export const ConfirmationStatus = z
  .enum(['available', 'unavailable', 'restricted', 'unknown'])
  .meta({ id: 'ConfirmationStatus', description: 'Provider-reported state for one exact name at one time' });
export type ConfirmationStatus = z.infer<typeof ConfirmationStatus>;

export const ProviderConfirmation = z
  .object({
    id: Uuid,
    providerId: ProviderId,
    domain: AsciiDomain,
    status: ConfirmationStatus,
    premium: z.boolean().nullable(),
    checkedAt: Timestamp,
    staleAt: Timestamp,
    freshness: Freshness,
    destination: z.string().meta({ description: 'API host the name was sent to' }),
    reason: Reason,
  })
  .meta({ id: 'ProviderConfirmation' });
export type ProviderConfirmation = z.infer<typeof ProviderConfirmation>;
