import { fromMinorUnits } from '../../pricing/money.js';
import type { ProviderHttpResponse } from '../transport.js';
import { isRecord, parseJson, str, tryJson } from './http.js';
import { ProviderError, draft, reason, type AdapterContext, type CheckResult, type DomainParts, type OfferDraft, type ProviderAdapter } from './types.js';

/**
 * GoDaddy Domains v3 (https://developer.godaddy.com/openapi/domains-v3.json, version 3.1.0).
 * v3 requires a Personal Access Token as a Bearer token. Money is `{currencyCode, value}` with value
 * in the currency's minor units. Availability pricing is documented as indicative.
 */
export const GODADDY_BASE = 'https://api.godaddy.com/v3/domains';
const NAME = 'GoDaddy';
const SPEC = 'https://developer.godaddy.com/openapi/domains-v3.json';

function headers(ctx: AdapterContext) {
  return { Authorization: `Bearer ${ctx.credentials.pat ?? ''}`, Accept: 'application/json' };
}

function errorDetail(response: ProviderHttpResponse): string | null {
  const body = tryJson(response);
  if (!isRecord(body)) return null;
  return [str(body.name), str(body.message)].filter(Boolean).join(': ') || null;
}

function money(value: unknown): { amount: string; currency: string } | null {
  if (!isRecord(value) || typeof value.currencyCode !== 'string') return null;
  const amount = fromMinorUnits(value.value, value.currencyCode);
  return amount === null ? null : { amount, currency: value.currencyCode.toUpperCase() };
}

export interface GoDaddyAvailability {
  domain: string;
  available: boolean | null;
  definitive: boolean | null;
  inventory: string | null;
  error: string | null;
  prices: unknown[];
}

/** Pure parser for check-availability (single result), exported for fixture tests. */
export function parseGoDaddyAvailability(body: unknown): GoDaddyAvailability {
  if (!isRecord(body) || typeof body.domain !== 'string') throw new ProviderError('bad_response', 'GoDaddy availability response has no domain');
  const error = isRecord(body.error) ? [str(body.error.name), str(body.error.message)].filter(Boolean).join(': ') || 'error' : null;
  return {
    domain: body.domain.toLowerCase(),
    available: typeof body.available === 'boolean' ? body.available : null,
    definitive: typeof body.definitive === 'boolean' ? body.definitive : null,
    inventory: typeof body.inventory === 'string' ? body.inventory : null,
    error,
    prices: Array.isArray(body.prices) ? body.prices : [],
  };
}

function toCheck(parsed: GoDaddyAvailability): CheckResult {
  const premium = parsed.inventory === null ? null : parsed.inventory !== 'REGISTRY';
  if (parsed.error || parsed.available === null) {
    return { status: 'unknown', premium, reason: reason('provider_error', `GoDaddy could not check this name${parsed.error ? ` (${parsed.error})` : ''}`) };
  }
  const how = parsed.definitive ? 'registry-confirmed' : 'from cached zone data';
  return parsed.available
    ? { status: 'available', premium, reason: reason('provider_available', `GoDaddy reported available (${how})`) }
    : { status: 'unavailable', premium, reason: reason('provider_unavailable', `GoDaddy reported unavailable (${how})`) };
}

/** Offer from the shortest-term price entry, exported for fixture tests. */
export function godaddyOffer(parsed: GoDaddyAvailability): OfferDraft | null {
  const terms = parsed.prices
    .filter((p): p is Record<string, unknown> => isRecord(p) && (p.term === undefined || p.term === 'YEAR') && typeof p.period === 'number')
    .sort((a, b) => (a.period as number) - (b.period as number));
  const term = terms[0];
  if (!term) return null;
  const price = money(term.price);
  if (!price) return null;
  const period = Math.max(1, Math.floor(term.period as number));
  // renewalPrice is "absent when renewal pricing is unavailable or identical": absence stays unknown.
  const renewal = money(term.renewalPrice);
  const fees = Array.isArray(term.fees)
    ? term.fees.filter(isRecord).map((f) => ({ label: str(f.type) ?? 'fee', amount: money(f.fee)?.amount ?? null }))
    : [];
  const premium = parsed.inventory === 'REGISTRY_PREMIUM' || parsed.inventory === 'PREMIUM';
  return draft({
    // PREMIUM inventory is a third-party marketplace listing (Afternic), not a new registration.
    purchasePath: parsed.inventory === 'PREMIUM' ? 'aftermarket' : 'new_registration',
    kind: 'exact_quote',
    currency: price.currency,
    registration: { amount: price.amount, years: period },
    minYears: period,
    renewal: { amount: renewal && renewal.currency === price.currency ? renewal.amount : null, years: period },
    fees: { icann: null, other: fees, tax: 'unknown' },
    premium: {
      status: parsed.inventory === null ? 'unknown' : premium ? 'confirmed' : 'not_premium',
      registration: premium ? price.amount : null,
      renewal: premium && renewal ? renewal.amount : null,
    },
    source: { label: `GoDaddy v3 check-availability (indicative, ${parsed.definitive ? 'registry-confirmed' : 'cached'})`, url: SPEC },
  });
}

export class GoDaddyAdapter implements ProviderAdapter {
  readonly providerId = 'godaddy';
  readonly testOperation = 'GET /v3/domains/domain-names?pageSize=1';

  async testCredentials(ctx: AdapterContext) {
    const response = await ctx.http.request({ method: 'GET', url: `${GODADDY_BASE}/domain-names?pageSize=1`, headers: headers(ctx) });
    ctx.http.assertOk(response, NAME, errorDetail(response));
    parseJson(response, NAME);
    return { operation: this.testOperation, message: 'GoDaddy accepted the personal access token (listing owned domains succeeded).' };
  }

  private async availability(ctx: AdapterContext, domain: DomainParts) {
    const params = new URLSearchParams({ domain: domain.ascii, optimizeFor: 'ACCURACY' });
    const response = await ctx.http.request({ method: 'GET', url: `${GODADDY_BASE}/check-availability?${params}`, headers: headers(ctx) });
    if (response.status === 422) {
      throw new ProviderError('unsupported', `GoDaddy cannot check this name: ${errorDetail(response) ?? 'unsupported TLD or business rule'}`, { status: 422 });
    }
    ctx.http.assertOk(response, NAME, errorDetail(response));
    const parsed = parseGoDaddyAvailability(parseJson(response, NAME));
    if (parsed.domain !== domain.ascii) throw new ProviderError('bad_response', 'GoDaddy answered for a different domain');
    return parsed;
  }

  async check(ctx: AdapterContext, domain: DomainParts) {
    return toCheck(await this.availability(ctx, domain));
  }

  async quote(ctx: AdapterContext, domain: DomainParts) {
    const parsed = await this.availability(ctx, domain);
    const check = toCheck(parsed);
    const offer = check.status === 'available' ? godaddyOffer(parsed) : null;
    return { check, offers: offer ? [offer] : [] };
  }
}
