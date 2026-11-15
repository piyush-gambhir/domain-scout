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

  | 'auth'

  | 'rate_limited'

  | 'transient'

  | 'bad_response'

  | 'rejected'

  | 'unsupported';


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

  ascii: string;

  label: string;

  suffix: string;
}

export interface AdapterContext {

  credentials: Record<string, string>;
  http: ProviderHttp;
  now: Date;
}


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

  promotional: boolean;
  publishedAt: string | null;
  quoteExpiresAt: string | null;
  source: Offer['source'];

  destination?: Offer['destination'];
}

export interface CatalogEntry extends OfferDraft {
  suffix: string;
}

export interface CatalogResult {

  suffixes: string[];
  entries: CatalogEntry[];

  source: string;
}

export interface CheckResult {
  status: ConfirmationStatus;
  premium: boolean | null;
  reason: Reason;
}

export interface QuoteResult {

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

  operation: string;
  message: string;
}


export interface ProviderAdapter {
  readonly providerId: string;

  readonly testOperation: string | null;
  testCredentials?(ctx: AdapterContext): Promise<CredentialTestOutcome>;
  catalog?(ctx: AdapterContext): Promise<CatalogResult>;
  check?(ctx: AdapterContext, domain: DomainParts): Promise<CheckResult>;
  quote?(ctx: AdapterContext, domain: DomainParts): Promise<QuoteResult>;
  transfer?(ctx: AdapterContext, domain: DomainParts): Promise<TransferResult>;
  aftermarket?(ctx: AdapterContext, domain: DomainParts): Promise<ListingResult>;
}

const UNKNOWN_FEES: Offer['fees'] = { icann: null, other: [], tax: 'unknown' };


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
