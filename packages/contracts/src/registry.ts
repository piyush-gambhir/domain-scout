import { z } from 'zod';
import { AsciiDomain, Freshness, Reason, Suffix, Timestamp, Uuid, envelope, page } from './common.js';

export const RegistryOutcome = z
  .enum(['registered', 'no_record', 'inconclusive', 'rate_limited', 'blocked', 'invalid', 'unsupported'])
  .meta({
    id: 'RegistryOutcome',
    description:
      'no_record means the authoritative registry source returned no registration record. It is not a guarantee that the name can be registered.',
  });
export type RegistryOutcome = z.infer<typeof RegistryOutcome>;

/** Outcomes that answer the question "is there a registration record". Everything else is unresolved. */
export const RESOLVED_OUTCOMES: readonly RegistryOutcome[] = ['registered', 'no_record'];

export const EligibilityStatus = z
  .enum(['unknown', 'unrestricted', 'reserved', 'restricted'])
  .meta({ id: 'EligibilityStatus' });
export type EligibilityStatus = z.infer<typeof EligibilityStatus>;

export const Eligibility = z
  .object({
    status: EligibilityStatus,
    source: z.string().nullable().meta({ description: 'Source establishing the status; null when unknown' }),
    scope: z.string().nullable().meta({ description: 'What the status applies to, e.g. a registry policy' }),
  })
  .meta({ id: 'Eligibility' });
export type Eligibility = z.infer<typeof Eligibility>;

export const RegistryProtocol = z.enum(['rdap', 'whois']).meta({ id: 'RegistryProtocol' });
export type RegistryProtocol = z.infer<typeof RegistryProtocol>;

export const RoutingSource = z
  .enum(['iana_bootstrap', 'curated'])
  .meta({ id: 'RoutingSource', description: 'Where the registry destination for this suffix came from' });

export const RegistrySource = z
  .object({
    registryId: z.string().meta({ description: 'Shared cooldown key for one registry operator or host' }),
    protocol: RegistryProtocol,
    destination: z.string().meta({ description: 'RDAP base URL or WHOIS host:port actually queried' }),
    routing: RoutingSource,
  })
  .meta({ id: 'RegistrySource' });
export type RegistrySource = z.infer<typeof RegistrySource>;

export const RegistrationDetails = z
  .object({
    registrar: z.string().nullable(),
    createdAt: Timestamp.nullable(),
    updatedAt: Timestamp.nullable(),
    expiresAt: Timestamp.nullable().meta({ description: 'Registry expiry date. A fact, not a drop prediction.' }),
    statuses: z.array(z.string()),
    nameservers: z.array(z.string()),
    dnssec: z.boolean().nullable(),
  })
  .meta({ id: 'RegistrationDetails' });
export type RegistrationDetails = z.infer<typeof RegistrationDetails>;

export const RegistryObservation = z
  .object({
    id: Uuid,
    domain: AsciiDomain,
    unicode: z.string(),
    suffix: Suffix,
    source: RegistrySource.nullable().meta({ description: 'Null when no source was queried (invalid or unsupported)' }),
    outcome: RegistryOutcome,
    eligibility: Eligibility,
    reason: Reason,
    checkedAt: Timestamp,
    staleAt: Timestamp,
    freshness: Freshness,
    reused: z.boolean().meta({ description: 'True when a job reused this observation from cache' }),
    httpStatus: z.number().int().nullable(),
    retryAt: Timestamp.nullable(),
    matchedName: z.string().nullable().meta({ description: 'Domain name the source returned, checked against the request' }),
    parserVersion: z.string(),
    registration: RegistrationDetails.nullable(),
    hasRawDiagnostics: z.boolean(),
  })
  .meta({ id: 'RegistryObservation' });
export type RegistryObservation = z.infer<typeof RegistryObservation>;

export const CoverageStatus = z
  .enum(['tested', 'discovered', 'unsupported'])
  .meta({
    id: 'CoverageStatus',
    description:
      'tested: classifier has fixtures and/or a live validation; discovered: a registry destination is known but classification is untested; unsupported: no usable public registry lookup is known',
  });
export type CoverageStatus = z.infer<typeof CoverageStatus>;

export const SuffixCoverage = z
  .object({
    suffix: Suffix,
    tld: z.string(),
    status: CoverageStatus,
    protocol: RegistryProtocol.nullable(),
    endpoint: z.string().nullable(),
    registryId: z.string().nullable(),
    routing: RoutingSource.nullable(),
    routingUpdatedAt: Timestamp.nullable(),
    fixtureTested: z.boolean(),
    liveValidatedAt: Timestamp.nullable(),
    liveValidation: z
      .array(z.object({ domain: AsciiDomain, expected: RegistryOutcome, observed: RegistryOutcome, at: Timestamp }))
      .meta({ description: 'Authorized live validation names and results' }),
    eligibilityNotes: z.array(z.object({ text: z.string(), source: z.string() })),
    notes: z.string().nullable(),
  })
  .meta({ id: 'SuffixCoverage' });
export type SuffixCoverage = z.infer<typeof SuffixCoverage>;

export const CoverageSummary = z
  .object({
    bootstrapPublishedAt: Timestamp.nullable(),
    bootstrapFetchedAt: Timestamp.nullable(),
    counts: z.object({ tested: z.number().int(), discovered: z.number().int(), unsupported: z.number().int() }),
    limits: z.array(z.string()),
  })
  .meta({ id: 'CoverageSummary' });
export type CoverageSummary = z.infer<typeof CoverageSummary>;

export const CoverageQuery = z.object({
  status: z.enum(['tested', 'discovered', 'unsupported']).optional(),
  q: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

export const CoverageListResponse = page(SuffixCoverage, 'CoverageListResponse');
export const CoverageSummaryResponse = envelope(CoverageSummary, 'CoverageSummaryResponse');
export const SuffixCoverageResponse = envelope(SuffixCoverage, 'SuffixCoverageResponse');
