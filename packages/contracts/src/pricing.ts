import { z } from 'zod';
import {
  AsciiDomain,
  CurrencyCode,
  DecimalString,
  Freshness,
  Suffix,
  Timestamp,
  Uuid,
  envelope,
  page,
} from './common.js';
import { ProviderId } from './providers.js';

export const PriceKind = z
  .enum(['published', 'estimated', 'exact_quote'])
  .meta({
    id: 'PriceKind',
    description:
      'published: a provider catalog price for the suffix; estimated: derived, e.g. future renewal; exact_quote: provider response for one exact name',
  });
export type PriceKind = z.infer<typeof PriceKind>;

export const PurchasePath = z
  .enum(['new_registration', 'renewal', 'transfer', 'aftermarket'])
  .meta({ id: 'PurchasePath' });
export type PurchasePath = z.infer<typeof PurchasePath>;

export const PremiumStatus = z
  .enum(['confirmed', 'not_premium', 'hint', 'unknown'])
  .meta({ id: 'PremiumStatus', description: 'hint: heuristic or catalog-level indication, not a confirmed premium' });

export const TaxState = z
  .enum(['unknown', 'included', 'excluded'])
  .meta({ id: 'TaxState', description: 'unknown tax is never treated as zero' });

export const PriceLine = z
  .object({
    amount: DecimalString.nullable().meta({ description: 'Null means unknown, never zero' }),
    years: z.number().int().min(1).meta({ description: 'Years covered by amount' }),
  })
  .meta({ id: 'PriceLine' });
export type PriceLine = z.infer<typeof PriceLine>;

export const TransferLine = z
  .object({
    amount: DecimalString.nullable().meta({ description: 'Null means unknown, never zero' }),
    includesYears: z
      .number()
      .int()
      .min(0)
      .nullable()
      .meta({ description: 'Registration years included with the transfer; 0 when none, null when unknown' }),
  })
  .meta({ id: 'TransferLine' });
export type TransferLine = z.infer<typeof TransferLine>;

export const Promotion = z
  .object({
    description: z.string(),
    requiresTermYears: z.number().int().nullable(),
    restrictions: z.string().nullable(),
    expiresAt: Timestamp.nullable(),
    eligibilityVerified: z.boolean().meta({ description: 'False when account or customer eligibility is unknown' }),
  })
  .meta({ id: 'Promotion' });

export const Offer = z
  .object({
    id: Uuid,
    providerId: ProviderId,
    domain: AsciiDomain.nullable().meta({ description: 'Null for suffix-level catalog prices' }),
    suffix: Suffix,
    purchasePath: PurchasePath,
    kind: PriceKind,
    currency: CurrencyCode,
    region: z.string().nullable(),
    registration: PriceLine,
    minYears: z.number().int().min(1).nullable().meta({ description: 'Minimum required registration term' }),
    renewal: PriceLine,
    transfer: TransferLine,
    fees: z.object({
      icann: DecimalString.nullable(),
      other: z.array(z.object({ label: z.string(), amount: DecimalString.nullable() })),
      tax: TaxState,
    }),
    premium: z.object({
      status: PremiumStatus,
      registration: DecimalString.nullable(),
      renewal: DecimalString.nullable(),
    }),
    promotion: Promotion.nullable(),
    observedAt: Timestamp,
    publishedAt: Timestamp.nullable(),
    quoteExpiresAt: Timestamp.nullable(),
    staleAt: Timestamp,
    freshness: Freshness,
    source: z.object({ label: z.string(), url: z.string().nullable() }),
    destination: z
      .object({ url: z.string(), kind: z.enum(['search', 'dashboard', 'website', 'checkout', 'listing']) })
      .nullable()
      .meta({ description: 'Purchase handoff for the same provider and purchase path' }),
  })
  .meta({ id: 'Offer' });
export type Offer = z.infer<typeof Offer>;

export const OfferListResponse = page(Offer, 'OfferListResponse');

export const ComparisonRequest = z
  .object({
    domains: z.array(AsciiDomain).min(1).max(500),
    horizonYears: z.number().int().min(1).max(10).default(3),
    purchasePath: PurchasePath.default('new_registration'),
    providerIds: z.array(ProviderId).optional(),
    currency: CurrencyCode.optional().meta({ description: 'Comparison currency; requires an attributed FX rate' }),
    region: z.string().optional(),
  })
  .meta({ id: 'ComparisonRequest' });
export type ComparisonRequest = z.input<typeof ComparisonRequest>;

export const MissingPriceField = z
  .enum(['registration', 'renewal', 'transfer', 'tax', 'fees', 'premium', 'promotion_eligibility', 'fx_rate'])
  .meta({ id: 'MissingPriceField' });

export const ComparisonRow = z
  .object({
    domain: AsciiDomain,
    providerId: ProviderId,
    offerId: Uuid.nullable(),
    kind: PriceKind.nullable(),
    currency: CurrencyCode.nullable(),
    nativeCurrency: CurrencyCode.nullable(),
    fx: z
      .object({ rate: DecimalString, source: z.string(), observedAt: Timestamp })
      .nullable(),
    initialCommitment: DecimalString.nullable(),
    initialYears: z.number().int().nullable(),
    horizonTotal: DecimalString.nullable().meta({ description: 'Initial commitment plus current renewal for remaining years. Future renewals are estimates.' }),
    prepaidBeyondHorizon: z
      .object({ years: z.number().int(), amount: DecimalString.nullable() })
      .nullable(),
    subtotalOnly: z.boolean().meta({ description: 'True when tax or fees are unknown, so the total is a base subtotal' }),
    complete: z.boolean(),
    missing: z.array(MissingPriceField),
    rank: z.number().int().nullable().meta({ description: 'Rank among complete comparable rows in the same currency; null when not rankable' }),
    freshness: Freshness.nullable(),
    observedAt: Timestamp.nullable(),
    destination: z.string().nullable(),
    notes: z.array(z.string()),
  })
  .meta({ id: 'ComparisonRow' });
export type ComparisonRow = z.infer<typeof ComparisonRow>;

export const Comparison = z
  .object({
    horizonYears: z.number().int(),
    purchasePath: PurchasePath,
    currency: CurrencyCode.nullable(),
    generatedAt: Timestamp,
    rows: z.array(ComparisonRow),
    cheapest: z
      .array(z.object({ domain: AsciiDomain, currency: CurrencyCode, providerId: ProviderId, horizonTotal: DecimalString }))
      .meta({ description: 'Cheapest complete comparable row per domain and currency' }),
    limits: z.array(z.string()),
  })
  .meta({ id: 'Comparison' });
export type Comparison = z.infer<typeof Comparison>;
export const ComparisonResponse = envelope(Comparison, 'ComparisonResponse');

export const PriceHistoryPoint = z
  .object({
    offerId: Uuid,
    observedAt: Timestamp,
    kind: PriceKind,
    registration: DecimalString.nullable(),
    renewal: DecimalString.nullable(),
    transfer: DecimalString.nullable(),
  })
  .meta({ id: 'PriceHistoryPoint' });

export const PriceSeries = z
  .object({
    key: z.string().meta({ description: 'Comparable series key: provider, scope, path, currency, region, term, promotion' }),
    providerId: ProviderId,
    scope: z.string().meta({ description: 'Suffix or exact domain the prices apply to' }),
    purchasePath: PurchasePath,
    currency: CurrencyCode,
    region: z.string().nullable(),
    termYears: z.number().int(),
    promotional: z.boolean(),
    points: z.array(PriceHistoryPoint),
    gaps: z
      .array(z.object({ from: Timestamp, to: Timestamp }))
      .meta({ description: 'Periods with no observations; never interpolated' }),
  })
  .meta({ id: 'PriceSeries' });
export type PriceSeries = z.infer<typeof PriceSeries>;

export const PriceHistoryQuery = z.object({
  domain: z.string().optional(),
  suffix: z.string().optional(),
  providerId: z.string().optional(),
  since: Timestamp.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const PriceHistoryResponse = page(PriceSeries, 'PriceHistoryResponse');

export const FxRate = z
  .object({
    from: CurrencyCode,
    to: CurrencyCode,
    rate: DecimalString,
    source: z.string().min(1),
    observedAt: Timestamp,
  })
  .meta({ id: 'FxRate' });
export type FxRate = z.infer<typeof FxRate>;
