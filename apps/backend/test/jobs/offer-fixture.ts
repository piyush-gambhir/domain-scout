import { randomUUID } from 'node:crypto';
import type { OfferWrite } from '../../src/storage/evidence.js';

/**
 * A contract-shaped offer row for engine-level tests (catalog prices with `domain: null`, exact
 * quotes otherwise). Hand-written reconstruction of the Offer contract, not a captured response.
 */
export function offerWrite(o: {
  providerId: string;
  domain: string | null;
  suffix: string;
  registration: string;
  observedAt: string;
  catalogFetchId?: string | null;
}): OfferWrite {
  const id = randomUUID();
  const kind = o.domain ? 'exact_quote' : 'published';
  const staleAt = new Date(Date.parse(o.observedAt) + (o.domain ? 15 : 24 * 60) * 60_000).toISOString();
  const payload = {
    id,
    providerId: o.providerId,
    domain: o.domain,
    suffix: o.suffix,
    purchasePath: 'new_registration',
    kind,
    currency: 'USD',
    region: null,
    registration: { amount: o.registration, years: 1 },
    minYears: 1,
    renewal: { amount: null, years: 1 },
    transfer: { amount: null, includesYears: null },
    fees: { icann: null, other: [], tax: 'unknown' },
    premium: { status: 'unknown', registration: null, renewal: null },
    promotion: null,
    observedAt: o.observedAt,
    publishedAt: null,
    quoteExpiresAt: null,
    staleAt,
    source: { label: `${o.providerId} test ${kind}`, url: null },
    destination: null,
  };
  return {
    id,
    providerId: o.providerId,
    domain: o.domain,
    suffix: o.suffix,
    purchasePath: 'new_registration',
    kind,
    currency: 'USD',
    region: null,
    termYears: 1,
    promotional: false,
    registration: o.registration,
    renewal: null,
    transfer: null,
    observedAt: o.observedAt,
    staleAt,
    quoteExpiresAt: null,
    catalogFetchId: o.catalogFetchId ?? null,
    payload,
  };
}
