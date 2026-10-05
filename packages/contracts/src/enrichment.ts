import { z } from 'zod';
import { AsciiDomain, Freshness, Money, Reason, Timestamp, Uuid, envelope, page } from './common.js';
import { ProviderId } from './providers.js';

export const NameCheckServiceId = z
  .enum(['github', 'npm', 'pypi', 'crates', 'x', 'instagram', 'tiktok', 'linkedin', 'youtube', 'reddit'])
  .meta({ id: 'NameCheckServiceId' });
export type NameCheckServiceId = z.infer<typeof NameCheckServiceId>;

export const NameCheckService = z
  .object({
    id: NameCheckServiceId,
    name: z.string(),
    namespace: z.string().meta({ description: 'Exact identifier type checked, e.g. GitHub user or organization login' }),
    supported: z.boolean(),
    destination: z.string().nullable(),
    reason: z.string().nullable().meta({ description: 'Why an unsupported service is unsupported' }),
  })
  .meta({ id: 'NameCheckService' });
export type NameCheckService = z.infer<typeof NameCheckService>;
export const NameCheckServiceListResponse = page(NameCheckService, 'NameCheckServiceListResponse');

export const NameCheckOutcome = z
  .enum(['exists', 'not_found', 'restricted', 'rate_limited', 'error', 'unsupported'])
  .meta({
    id: 'NameCheckOutcome',
    description: 'not_found means no public record was returned. It does not mean the name is claimable.',
  });
export type NameCheckOutcome = z.infer<typeof NameCheckOutcome>;

export const NameCheck = z
  .object({
    id: Uuid,
    name: z.string(),
    service: NameCheckServiceId,
    namespace: z.string(),
    outcome: NameCheckOutcome,
    destination: z.string().nullable(),
    httpStatus: z.number().int().nullable(),
    checkedAt: Timestamp,
    staleAt: Timestamp,
    freshness: Freshness,
    reason: Reason,
    detail: z.record(z.string(), z.unknown()).nullable(),
  })
  .meta({ id: 'NameCheck' });
export type NameCheck = z.infer<typeof NameCheck>;

export const DiagnosticCheck = z
  .enum(['dns', 'nameservers', 'dnssec', 'tls', 'http'])
  .meta({ id: 'DiagnosticCheck' });
export type DiagnosticCheck = z.infer<typeof DiagnosticCheck>;

export const Resolver = z
  .enum(['system', 'cloudflare', 'google'])
  .meta({ id: 'Resolver', description: 'system uses the OS resolver; cloudflare and google use DNS over HTTPS' });
export type Resolver = z.infer<typeof Resolver>;

export const DiagnosticOutcome = z
  .enum(['observed', 'no_answer', 'error', 'unreachable', 'timeout'])
  .meta({ id: 'DiagnosticOutcome' });
export type DiagnosticOutcome = z.infer<typeof DiagnosticOutcome>;

export const Diagnostic = z
  .object({
    id: Uuid,
    domain: AsciiDomain,
    check: DiagnosticCheck,
    outcome: DiagnosticOutcome,
    destination: z.string().meta({ description: 'Resolver or host contacted' }),
    checkedAt: Timestamp,
    staleAt: Timestamp,
    freshness: Freshness,
    reason: Reason,
    data: z.record(z.string(), z.unknown()).meta({ description: 'Observed answer, e.g. records, certificate fields or HTTP status' }),
  })
  .meta({ id: 'Diagnostic', description: 'Diagnostics never change registry outcomes' });
export type Diagnostic = z.infer<typeof Diagnostic>;

export const ListingStatus = z
  .enum(['fixed_price', 'auction', 'make_offer', 'not_listed', 'unknown'])
  .meta({ id: 'ListingStatus' });

export const AftermarketListing = z
  .object({
    id: Uuid,
    domain: AsciiDomain,
    marketplace: z.string(),
    providerId: ProviderId.nullable(),
    status: ListingStatus,
    price: Money.nullable(),
    url: z.string().nullable(),
    observedAt: Timestamp,
    freshness: Freshness,
    source: z.string(),
    caveat: z.string().meta({ description: 'Listing evidence is not proof of seller authority or final cost' }),
  })
  .meta({ id: 'AftermarketListing' });
export type AftermarketListing = z.infer<typeof AftermarketListing>;
export const AftermarketListResponse = page(AftermarketListing, 'AftermarketListResponse');

export const AftermarketSource = z
  .object({
    id: z.string(),
    name: z.string(),
    supported: z.boolean(),
    requiresCredentials: z.boolean(),
    apiHosts: z.array(z.string()).meta({ description: 'Hosts that receive domain names during lookups' }),
    searchUrlTemplate: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .meta({ id: 'AftermarketSource' });

export const PortfolioEntry = z
  .object({
    id: Uuid,
    domain: AsciiDomain,
    registrar: z.string().nullable(),
    renewalDate: z.string().nullable().meta({ description: 'User-supplied renewal date (YYYY-MM-DD)' }),
    renewalPrice: Money.nullable().meta({ description: 'User-supplied current renewal price' }),
    notes: z.string().nullable(),
    source: z.literal('user'),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'PortfolioEntry' });
export type PortfolioEntry = z.infer<typeof PortfolioEntry>;
export const PortfolioListResponse = page(PortfolioEntry, 'PortfolioListResponse');

export const PortfolioImport = z
  .object({
    text: z.string().max(2_000_000).optional().meta({ description: 'CSV with domain, registrar, renewalDate, renewalPrice, currency, notes' }),
    entries: z
      .array(
        z.object({
          domain: z.string(),
          registrar: z.string().optional(),
          renewalDate: z.string().optional(),
          renewalPrice: Money.optional(),
          notes: z.string().optional(),
        }),
      )
      .optional(),
    replace: z.boolean().default(false),
  })
  .meta({ id: 'PortfolioImport' });

export const PortfolioImportResult = z
  .object({
    imported: z.number().int(),
    updated: z.number().int(),
    rejected: z.array(z.object({ row: z.number().int(), input: z.string(), reason: z.string() })),
  })
  .meta({ id: 'PortfolioImportResult' });
export const PortfolioImportResponse = envelope(PortfolioImportResult, 'PortfolioImportResponse');

export const PortfolioComparisonRow = z
  .object({
    entry: PortfolioEntry,
    alternatives: z.array(
      z.object({
        providerId: ProviderId,
        transfer: Money.nullable(),
        renewal: Money.nullable(),
        kind: z.enum(['published', 'exact_quote']),
        freshness: Freshness,
        observedAt: Timestamp,
        transferIncludesYears: z.number().int().nullable(),
      }),
    ),
    notes: z.array(z.string()),
  })
  .meta({ id: 'PortfolioComparisonRow' });
export const PortfolioComparisonResponse = page(PortfolioComparisonRow, 'PortfolioComparisonResponse');

export const TransferOption = z
  .object({
    domain: AsciiDomain,
    providerId: ProviderId,
    transfer: Money.nullable(),
    includesYears: z.number().int().nullable(),
    renewal: Money.nullable(),
    kind: z.enum(['published', 'exact_quote']),
    freshness: Freshness,
    observedAt: Timestamp,
    eligibility: z.object({
      known: z.array(z.string()).meta({ description: 'Sourced facts, e.g. registry status clientTransferProhibited' }),
      unknown: z.array(z.string()),
    }),
    destination: z.string().nullable(),
  })
  .meta({ id: 'TransferOption', description: 'Read-only comparison; no authorization codes or transfers are handled' });
export type TransferOption = z.infer<typeof TransferOption>;
