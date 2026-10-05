import type {
  ConfirmationStatus,
  Money,
  Offer,
  PriceKind,
  PriceLine,
  PurchasePath,
  Reason,
  TransferLine,
} from '@domain-scout/contracts';
import type { ProviderHttp } from './http.js';

export type ProviderErrorKind =
  /** 401/403 or a provider-specific authentication failure: credentials need attention. */
  | 'auth'
  /** 429 or a provider rate-limit envelope; `retryAt` carries the provider's wait. */
  | 'rate_limited'
  /** Network failure, timeout or 5xx: eligible for automatic retry. */
  | 'transient'
  /** The response could not be parsed or did not match the documented shape. */
  | 'bad_response'
  /** The provider rejected the request (4xx validation and similar); not retried. */
  | 'rejected'
  /** The provider does not sell this suffix or support this operation for it. */
  | 'unsupported';

/** Adapter failure. Messages are written for people and never contain secrets or authenticated URLs. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly extras: { status?: number | null; retryAt?: string | null } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface DomainParts {
  /** Lower-case ASCII domain, e.g. `example.co.uk`. */
  ascii: string;
  /** Registrable label without the suffix, e.g. `example`. */
  label: string;
  /** Registration suffix without a leading dot, e.g. `co.uk`. */
  suffix: string;
}

export interface AdapterContext {
  /** Resolved credential values; empty for keyless calls. */
  credentials: Record<string, string>;
  http: ProviderHttp;
  now: Date;
}

/** Offer fields an adapter can know; the handler adds identity, timestamps, freshness and destination. */
export interface OfferDraft {
  purchasePath: PurchasePath;
  kind: PriceKind;
  currency: string;
  region: string | null;
  registration: PriceLine;
  minYears: number | null;
  renewal: PriceLine;
  transfer: TransferLine;
  fees: Offer['fees'];
  premium: Offer['premium'];
  promotion: Offer['promotion'];
  /** The registration amount already includes a promotion. */
  promotional: boolean;
  publishedAt: string | null;
  quoteExpiresAt: string | null;
  source: Offer['source'];
  /** Provider-supplied listing destination (aftermarket); otherwise built from the manifest. */
  destination?: Offer['destination'];
}

export interface CatalogEntry extends OfferDraft {
  suffix: string;
}

export interface CatalogResult {
  /** Every suffix the provider lists, including ones without usable prices. */
  suffixes: string[];
  entries: CatalogEntry[];
  /** Source label recorded on catalog_fetches. */
  source: string;
}

export interface CheckResult {
  status: ConfirmationStatus;
  premium: boolean | null;
  reason: Reason;
}

export interface QuoteResult {
  /** Availability stated by the same response, recorded as a confirmation. */
  check: CheckResult | null;
  offers: OfferDraft[];
}

export interface TransferResult {
  offers: OfferDraft[];
  reason: Reason;
}

export interface ListingResult {
  status: 'fixed_price' | 'auction' | 'make_offer' | 'not_listed' | 'unknown';
  price: Money | null;
  url: string | null;
  marketplace: string;
  reason: Reason;
}

export interface CredentialTestOutcome {
  /** The non-candidate account operation used, e.g. `GET /ping`. */
  operation: string;
  message: string;
}

/** One provider integration. Each capability is optional and independent. */
export interface ProviderAdapter {
  readonly providerId: string;
  /** Operation used to test credentials; null when no documented non-candidate operation exists. */
  readonly testOperation: string | null;
  testCredentials?(ctx: AdapterContext): Promise<CredentialTestOutcome>;
  catalog?(ctx: AdapterContext): Promise<CatalogResult>;
  check?(ctx: AdapterContext, domain: DomainParts): Promise<CheckResult>;
  quote?(ctx: AdapterContext, domain: DomainParts): Promise<QuoteResult>;
  transfer?(ctx: AdapterContext, domain: DomainParts): Promise<TransferResult>;
  aftermarket?(ctx: AdapterContext, domain: DomainParts): Promise<ListingResult>;
}

const UNKNOWN_FEES: Offer['fees'] = { icann: null, other: [], tax: 'unknown' };

/** A draft with every amount unknown; adapters fill in what the provider states. */
export function draft(partial: Partial<OfferDraft> & Pick<OfferDraft, 'kind' | 'currency' | 'source'>): OfferDraft {
  return {
    purchasePath: 'new_registration',
    region: null,
    registration: { amount: null, years: 1 },
    minYears: null,
    renewal: { amount: null, years: 1 },
    transfer: { amount: null, includesYears: null },
    fees: { ...UNKNOWN_FEES, other: [] },
    premium: { status: 'unknown', registration: null, renewal: null },
    promotion: null,
    promotional: false,
    publishedAt: null,
    quoteExpiresAt: null,
    ...partial,
  };
}

export function reason(code: string, message: string): Reason {
  return { code, message };
}
