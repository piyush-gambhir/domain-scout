import { z } from 'zod';
import { AsciiDomain, CurrencyCode, DecimalString, Suffix, Timestamp, Uuid, envelope, page } from './common.js';
import { InputSource } from './inputs.js';
import { RegistryObservation, RegistryOutcome } from './registry.js';
import { ConfirmationStatus, ProviderConfirmation, ProviderId } from './providers.js';
import { Offer, PriceKind } from './pricing.js';
import {
  AftermarketListing,
  Diagnostic,
  DiagnosticCheck,
  NameCheck,
  NameCheckServiceId,
  Resolver,
} from './enrichment.js';

export const JobType = z
  .enum([
    'registry_scan',
    'provider_check',
    'quote',
    'aftermarket',
    'transfer',
    'name_check',
    'diagnostics',
    'catalog_refresh',
    'watch',
  ])
  .meta({ id: 'JobType' });
export type JobType = z.infer<typeof JobType>;

export const JobState = z
  .enum(['queued', 'running', 'cancelling', 'cancelled', 'completed', 'completed_with_errors', 'interrupted'])
  .meta({ id: 'JobState' });
export type JobState = z.infer<typeof JobState>;

export const TERMINAL_JOB_STATES: readonly JobState[] = [
  'cancelled',
  'completed',
  'completed_with_errors',
  'interrupted',
];

export const ItemState = z
  .enum(['pending', 'running', 'finished', 'interrupted'])
  .meta({ id: 'ItemState', description: 'Execution state; the source outcome is separate' });
export type ItemState = z.infer<typeof ItemState>;

export const JobOperation = z
  .enum(['registry', 'provider_check', 'quote', 'aftermarket', 'transfer', 'name_check', 'diagnostic', 'catalog'])
  .meta({ id: 'JobOperation' });
export type JobOperation = z.infer<typeof JobOperation>;

export const JobCounters = z
  .object({
    total: z.number().int(),
    pending: z.number().int(),
    running: z.number().int(),
    finished: z.number().int(),
    interrupted: z.number().int(),
    resolved: z.number().int(),
    unresolved: z.number().int().meta({ description: 'Finished items without a definitive answer (inconclusive, rate limited, blocked, errors)' }),
    outcomes: z.record(z.string(), z.number().int()),
  })
  .meta({ id: 'JobCounters' });
export type JobCounters = z.infer<typeof JobCounters>;

export const Job = z
  .object({
    id: Uuid,
    type: JobType,
    state: JobState,
    label: z.string().nullable(),
    createdAt: Timestamp,
    startedAt: Timestamp.nullable(),
    finishedAt: Timestamp.nullable(),
    updatedAt: Timestamp,
    counters: JobCounters,
    destinations: z.array(z.string()).meta({ description: 'Every external destination this job may contact' }),
    input: z.object({
      extensions: z.array(Suffix),
      providerIds: z.array(ProviderId),
      services: z.array(z.string()),
      checks: z.array(z.string()),
      rows: z.number().int(),
      text: z.string().nullable().meta({ description: 'Original pasted input, kept to restore the scan' }),
    }),
    watchId: Uuid.nullable(),
    parentJobId: Uuid.nullable().meta({ description: 'Job this one retried or rechecked' }),
    nextRetryAt: Timestamp.nullable(),
  })
  .meta({ id: 'Job' });
export type Job = z.infer<typeof Job>;

export const ItemError = z
  .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
  .meta({ id: 'ItemError' });

export const BestPrice = z
  .object({
    providerId: ProviderId,
    amount: DecimalString,
    currency: CurrencyCode,
    kind: PriceKind,
    years: z.number().int(),
  })
  .meta({ id: 'BestPrice', description: 'Lowest known first-year registration price among enabled providers; never a confirmed total' });

export const JobItem = z
  .object({
    id: Uuid,
    jobId: Uuid,
    subject: z.string().meta({ description: 'ASCII domain, or the name for name checks' }),
    unicode: z.string(),
    suffix: Suffix.nullable(),
    operation: JobOperation,
    target: z.string().nullable().meta({ description: 'Provider, service or diagnostic check id' }),
    state: ItemState,
    attempts: z.number().int(),
    outcome: z.string().nullable().meta({ description: 'Operation-specific outcome, e.g. a RegistryOutcome' }),
    resolved: z.boolean(),
    error: ItemError.nullable(),
    retryAt: Timestamp.nullable(),
    startedAt: Timestamp.nullable(),
    finishedAt: Timestamp.nullable(),
    evidence: z
      .object({
        registry: RegistryObservation.nullable(),
        confirmation: ProviderConfirmation.nullable(),
        offers: z.array(Offer),
        nameCheck: NameCheck.nullable(),
        diagnostic: Diagnostic.nullable(),
        listing: AftermarketListing.nullable(),
      })
      .meta({ description: 'Evidence observed for this item; other kinds are null or empty' }),
    bestPrice: BestPrice.nullable(),
    collectionIds: z.array(Uuid),
  })
  .meta({ id: 'JobItem' });
export type JobItem = z.infer<typeof JobItem>;

const ScanJob = z
  .object({
    type: z.literal('registry_scan'),
    label: z.string().max(200).optional(),
    input: InputSource,
    recheck: z.boolean().default(false).meta({ description: 'Ignore cached observations and query again' }),
  })
  .meta({ id: 'ScanJobRequest' });

const DomainsByProviders = {
  label: z.string().max(200).optional(),
  domains: z.array(AsciiDomain).min(1).max(10_000),
  providerIds: z.array(ProviderId).min(1),
};

const ProviderCheckJob = z
  .object({ type: z.literal('provider_check'), ...DomainsByProviders })
  .meta({ id: 'ProviderCheckJobRequest' });
const QuoteJob = z.object({ type: z.literal('quote'), ...DomainsByProviders }).meta({ id: 'QuoteJobRequest' });
const TransferJob = z.object({ type: z.literal('transfer'), ...DomainsByProviders }).meta({ id: 'TransferJobRequest' });
const AftermarketJob = z
  .object({
    type: z.literal('aftermarket'),
    label: z.string().max(200).optional(),
    domains: z.array(AsciiDomain).min(1).max(10_000),
    sources: z.array(z.string()).min(1),
  })
  .meta({ id: 'AftermarketJobRequest' });
const NameCheckJob = z
  .object({
    type: z.literal('name_check'),
    label: z.string().max(200).optional(),
    names: z.array(z.string().min(1).max(214)).min(1).max(10_000),
    services: z.array(NameCheckServiceId).min(1),
  })
  .meta({ id: 'NameCheckJobRequest' });
const DiagnosticsJob = z
  .object({
    type: z.literal('diagnostics'),
    label: z.string().max(200).optional(),
    domains: z.array(AsciiDomain).min(1).max(10_000),
    checks: z.array(DiagnosticCheck).min(1),
    resolver: Resolver.default('system'),
  })
  .meta({ id: 'DiagnosticsJobRequest' });

export const CreateJobRequest = z
  .discriminatedUnion('type', [ScanJob, ProviderCheckJob, QuoteJob, TransferJob, AftermarketJob, NameCheckJob, DiagnosticsJob])
  .meta({ id: 'CreateJobRequest' });
export type CreateJobRequest = z.input<typeof CreateJobRequest>;
export type CreateJobRequestParsed = z.output<typeof CreateJobRequest>;

/** Bodies for the operation-specific endpoints (POST /quotes etc.); type is implied by the path. */
export const ProviderJobBody = z.object(DomainsByProviders).meta({ id: 'ProviderJobBody' });
export const AftermarketJobBody = AftermarketJob.omit({ type: true }).meta({ id: 'AftermarketJobBody' });
export const NameCheckJobBody = NameCheckJob.omit({ type: true }).meta({ id: 'NameCheckJobBody' });
export const DiagnosticsJobBody = DiagnosticsJob.omit({ type: true }).meta({ id: 'DiagnosticsJobBody' });

export const JobResponse = envelope(Job, 'JobResponse');
export const JobListResponse = page(Job, 'JobListResponse');
export const JobItemListResponse = page(JobItem, 'JobItemListResponse');

export const JobListQuery = z.object({
  type: JobType.optional(),
  state: JobState.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const ResultSort = z
  .enum(['input', 'domain', 'suffix', 'length', 'outcome', 'checkedAt', 'price'])
  .meta({ id: 'ResultSort' });

/** One filter/sort specification shared by result views, CLI queries, exports and saved criteria. */
export const ResultFilter = z
  .object({
    q: z.string().max(200).optional().meta({ description: 'Substring match on the domain or name' }),
    outcomes: z.array(z.string()).optional(),
    suffixes: z.array(Suffix).optional(),
    states: z.array(ItemState).optional(),
    resolved: z.boolean().optional(),
    confirmations: z.array(ConfirmationStatus).optional(),
    maxPrice: DecimalString.optional(),
    priceCurrency: CurrencyCode.optional(),
    maxLength: z.number().int().min(1).max(63).optional(),
    collectionId: Uuid.optional(),
    sort: ResultSort.default('input'),
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  .meta({ id: 'ResultFilter' });
export type ResultFilter = z.input<typeof ResultFilter>;
export type ResultFilterParsed = z.output<typeof ResultFilter>;

/** Query-string form of ResultFilter: list values are comma separated. */
export const ResultQuery = z.object({
  q: z.string().optional(),
  outcomes: z.string().optional(),
  suffixes: z.string().optional(),
  states: z.string().optional(),
  resolved: z.enum(['true', 'false']).optional(),
  confirmations: z.string().optional(),
  maxPrice: z.string().optional(),
  priceCurrency: z.string().optional(),
  maxLength: z.coerce.number().int().optional(),
  collectionId: z.string().optional(),
  sort: ResultSort.optional(),
  order: z.enum(['asc', 'desc']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type ResultQuery = z.input<typeof ResultQuery>;

/** Convert the query-string form into a structured filter. */
export function resultFilterFromQuery(query: z.output<typeof ResultQuery>): ResultFilterParsed {
  const list = (value: string | undefined) =>
    value === undefined || value === '' ? undefined : value.split(',').map((v) => v.trim()).filter(Boolean);
  return ResultFilter.parse({
    q: query.q,
    outcomes: list(query.outcomes),
    suffixes: list(query.suffixes),
    states: list(query.states),
    resolved: query.resolved === undefined ? undefined : query.resolved === 'true',
    confirmations: list(query.confirmations),
    maxPrice: query.maxPrice,
    priceCurrency: query.priceCurrency,
    maxLength: query.maxLength,
    collectionId: query.collectionId,
    sort: query.sort,
    order: query.order,
  });
}

/** Convert a structured filter into query-string parameters. */
export function resultFilterToQuery(filter: ResultFilter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null) continue;
    out[key] = Array.isArray(value) ? value.join(',') : String(value);
  }
  return out;
}

export const RetryRequest = z
  .object({
    itemIds: z.array(Uuid).optional().meta({ description: 'Retry only these items' }),
    outcomes: z.array(z.string()).optional().meta({ description: 'Retry finished items with these outcomes' }),
    unresolvedOnly: z.boolean().default(true),
  })
  .meta({ id: 'RetryRequest' });

export const RecheckRequest = z
  .object({
    domains: z.array(AsciiDomain).min(1).max(10_000),
    label: z.string().max(200).optional(),
  })
  .meta({ id: 'RecheckRequest', description: 'Fresh registry checks for selected domains; prior evidence is kept' });

/**
 * Outcome strings that count as resolved (a definitive answer) per operation. Everything else that
 * finished is unresolved, including unsupported and credential_required: they are not answers, and
 * retrying them can succeed after coverage or credentials change.
 */
export const RESOLVED_ITEM_OUTCOMES: Record<JobOperation, readonly string[]> = {
  registry: ['registered', 'no_record', 'invalid'] satisfies RegistryOutcome[],
  provider_check: ['available', 'unavailable', 'restricted'],
  quote: ['quoted', 'unavailable', 'restricted'],
  transfer: ['quoted'],
  aftermarket: ['listed', 'not_listed'],
  name_check: ['exists', 'not_found'],
  diagnostic: ['observed', 'no_answer'],
  catalog: ['updated', 'unchanged'],
};
