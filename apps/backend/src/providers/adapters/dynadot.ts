import { parseAmount } from '../../pricing/money.js';
import type { ProviderHttpResponse } from '../transport.js';
import { isRecord, str, tryJson, yesNo } from './http.js';
import {
  ProviderError,
  draft,
  reason,
  type AdapterContext,
  type CatalogEntry,
  type CatalogResult,
  type CheckResult,
  type DomainParts,
  type ListingResult,
  type ProviderAdapter,
} from './types.js';

/**
 * Dynadot RESTful API v2 (beta; https://www.dynadot.com/domain/api-document, command metadata read
 * 2026-10-05). Bearer API key; search, TLD price and listing commands need no X-Signature.
 * Responses are `{code, message, data}` or `{code, message, error: {description}}`; examples mix
 * `Code`/`Data` casing, so both are accepted.
 */
export const DYNADOT_BASE = 'https://api.dynadot.com/restful/v2';
const NAME = 'Dynadot';
const DOC = 'https://www.dynadot.com/domain/api-document';

function headers(ctx: AdapterContext) {
  return { Authorization: `Bearer ${ctx.credentials.apiKey ?? ''}`, Accept: 'application/json' };
}

function field(body: Record<string, unknown>, name: string): unknown {
  return body[name] ?? body[name[0]!.toUpperCase() + name.slice(1)];
}

function errorText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const error = field(body, 'error');
  return (isRecord(error) ? str(field(error, 'description')) : null) ?? str(field(body, 'message'));
}

/** Returns `data` from a successful envelope, mapping HTTP and envelope errors. */
function data(ctx: AdapterContext, response: ProviderHttpResponse): Record<string, unknown> {
  const body = tryJson(response);
  const code = isRecord(body) ? Number(field(body, 'code')) : NaN;
  // The envelope code mirrors the HTTP status; prefer it when the HTTP layer says 200.
  const status = response.status === 200 && Number.isFinite(code) && code !== 200 ? code : response.status;
  if (status === 429) {
    throw new ProviderError('rate_limited', `Dynadot rate limit reached: ${errorText(body) ?? 'too many requests'}`, {
      status,
      retryAt: ctx.http.retryAt(response, 60),
    });
  }
  ctx.http.assertOk({ ...response, status }, NAME, errorText(body));
  if (!isRecord(body)) throw new ProviderError('bad_response', 'Dynadot response is not JSON', { status: response.status });
  const payload = field(body, 'data');
  return isRecord(payload) ? payload : {};
}

/** "(price/1 year)", "1 Year", "(Price/2 year)" to years. */
function unitYears(unit: unknown): number | null {
  const match = /(\d+)\s*year/i.exec(String(unit ?? ''));
  return match ? Number(match[1]) : null;
}

export interface DynadotSearch {
  available: boolean | null;
  premium: boolean | null;
  premiumKnown: boolean;
  price: { currency: string; years: number; registration: string | null; renewal: string | null; transfer: string | null } | null;
}

/** Pure parser for /domains/{domain}/search, exported for fixture tests. */
export function parseDynadotSearch(payload: Record<string, unknown>, domain: string): DynadotSearch {
  const name = str(payload.domain_name);
  if (name && name.toLowerCase() !== domain) throw new ProviderError('bad_response', 'Dynadot answered for a different domain');
  const premiumText = str(payload.premium)?.toLowerCase() ?? 'unknown';
  const list = Array.isArray(payload.price_list) ? payload.price_list.filter(isRecord) : [];
  const withYears = list.map((p) => ({ p, years: unitYears(p.unit) })).filter((x) => x.years !== null) as { p: Record<string, unknown>; years: number }[];
  withYears.sort((a, b) => a.years - b.years);
  const first = withYears[0];
  const currency = first && typeof first.p.currency === 'string' ? first.p.currency.toUpperCase() : null;
  return {
    available: yesNo(payload.available),
    premium: premiumText === 'yes' ? true : premiumText === 'no' ? false : null,
    premiumKnown: premiumText === 'yes' || premiumText === 'no',
    price:
      first && currency
        ? {
            currency,
            years: first.years,
            registration: parseAmount(first.p.registration_price, { stripSymbol: true }),
            renewal: parseAmount(first.p.renewal_price, { stripSymbol: true }),
            transfer: parseAmount(first.p.transfer_price, { stripSymbol: true }),
          }
        : null,
  };
}

function toCheck(parsed: DynadotSearch): CheckResult {
  if (parsed.available === null) return { status: 'unknown', premium: parsed.premium, reason: reason('provider_unclear', 'Dynadot did not state availability') };
  return parsed.available
    ? { status: 'available', premium: parsed.premium, reason: reason('provider_available', 'Dynadot search reported available') }
    : { status: 'unavailable', premium: parsed.premium, reason: reason('provider_unavailable', 'Dynadot search reported not available') };
}

/** Pure parser for one get_tld_price page, exported for fixture tests. */
export function parseDynadotTldPrices(payload: Record<string, unknown>): { entries: CatalogEntry[]; suffixes: string[]; count: number } {
  if (!Array.isArray(payload.tld_price_list)) throw new ProviderError('bad_response', 'Dynadot TLD price response has no tld_price_list');
  if (typeof payload.currency !== 'string') throw new ProviderError('bad_response', 'Dynadot TLD price response has no currency');
  const currency = payload.currency.toUpperCase();
  const list = payload.tld_price_list.filter(isRecord);
  const entries: CatalogEntry[] = [];
  const suffixes: string[] = [];
  for (const item of list) {
    const tld = str(item.tld)?.toLowerCase().replace(/^\./, '');
    if (!tld || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(tld)) continue;
    suffixes.push(tld);
    // Element format of the per-year lists is undocumented: only a plain first element is used.
    const firstOf = (value: unknown) => (Array.isArray(value) && value.length ? parseAmount(value[0], { stripSymbol: true }) : null);
    const minYears = typeof item.min_duration === 'number' && item.min_duration >= 1 ? item.min_duration : null;
    entries.push({
      suffix: tld,
      ...draft({
        kind: 'published',
        currency,
        registration: { amount: firstOf(item.all_years_register_price), years: 1 },
        renewal: { amount: firstOf(item.all_years_renew_price), years: 1 },
        transfer: { amount: parseAmount(item.transfer_price, { stripSymbol: true }), includesYears: null },
        minYears,
        source: { label: 'Dynadot get_tld_price (per-year list format unconfirmed)', url: DOC },
      }),
    });
  }
  return { entries, suffixes, count: list.length };
}

const LISTING_TYPES: Record<string, ListingResult['status']> = { bin: 'fixed_price', bin_make_offer: 'fixed_price', make_offer: 'make_offer' };

export class DynadotAdapter implements ProviderAdapter {
  readonly providerId = 'dynadot';
  readonly testOperation = 'GET /restful/v2/domains/get_tld_price?page_size=1';

  async testCredentials(ctx: AdapterContext) {
    const response = await ctx.http.request({ method: 'GET', url: `${DYNADOT_BASE}/domains/get_tld_price?currency=usd&page=1&page_size=1`, headers: headers(ctx) });
    data(ctx, response);
    return { operation: this.testOperation, message: 'Dynadot accepted the API key (TLD price query succeeded).' };
  }

  async catalog(ctx: AdapterContext): Promise<CatalogResult> {
    const entries: CatalogEntry[] = [];
    const suffixes: string[] = [];
    const pageSize = 500;
    for (let page = 1; page <= 50; page++) {
      const params = new URLSearchParams({ currency: 'usd', page: String(page), page_size: String(pageSize) });
      const response = await ctx.http.request({ method: 'GET', url: `${DYNADOT_BASE}/domains/get_tld_price?${params}`, headers: headers(ctx) });
      const parsed = parseDynadotTldPrices(data(ctx, response));
      entries.push(...parsed.entries);
      suffixes.push(...parsed.suffixes);
      if (parsed.count < pageSize) break;
    }
    return { suffixes, entries, source: 'Dynadot get_tld_price' };
  }

  private async search(ctx: AdapterContext, domain: DomainParts) {
    const params = new URLSearchParams({ show_price: 'true', currency: 'usd' });
    const response = await ctx.http.request({
      method: 'GET',
      url: `${DYNADOT_BASE}/domains/${encodeURIComponent(domain.ascii)}/search?${params}`,
      headers: headers(ctx),
    });
    return parseDynadotSearch(data(ctx, response), domain.ascii);
  }

  async check(ctx: AdapterContext, domain: DomainParts) {
    return toCheck(await this.search(ctx, domain));
  }

  async quote(ctx: AdapterContext, domain: DomainParts) {
    const parsed = await this.search(ctx, domain);
    const check = toCheck(parsed);
    if (check.status !== 'available' || !parsed.price) return { check, offers: [] };
    const p = parsed.price;
    return {
      check,
      offers: [
        draft({
          kind: 'exact_quote',
          currency: p.currency,
          registration: { amount: p.registration, years: p.years },
          minYears: p.years,
          renewal: { amount: p.renewal, years: p.years },
          transfer: { amount: p.transfer, includesYears: null },
          premium: {
            status: parsed.premiumKnown ? (parsed.premium ? 'confirmed' : 'not_premium') : 'unknown',
            registration: parsed.premium ? p.registration : null,
            renewal: parsed.premium ? p.renewal : null,
          },
          source: { label: 'Dynadot search (show_price)', url: DOC },
        }),
      ],
    };
  }

  async aftermarket(ctx: AdapterContext, domain: DomainParts): Promise<ListingResult> {
    const response = await ctx.http.request({
      method: 'GET',
      url: `${DYNADOT_BASE}/aftermarket/listings/${encodeURIComponent(domain.ascii)}?currency=usd`,
      headers: headers(ctx),
    });
    const marketplace = 'Dynadot Marketplace';
    if (response.status === 404) {
      // The documented 404 text is about the account, so absence of a listing is not established.
      return { status: 'unknown', price: null, url: null, marketplace, reason: reason('not_found', errorText(tryJson(response)) ?? 'Dynadot returned 404') };
    }
    const payload = data(ctx, response);
    const item = payload.listing_item;
    // The response for an unlisted name is undocumented, so a missing item stays unknown.
    if (!isRecord(item)) return { status: 'unknown', price: null, url: null, marketplace, reason: reason('no_listing_item', 'Dynadot returned no listing item; absence is not documented') };
    const type = (str(item.type) ?? '').toLowerCase();
    const amount = parseAmount(item.price, { stripSymbol: true });
    return {
      status: LISTING_TYPES[type] ?? 'unknown',
      price: amount ? { amount, currency: 'USD' } : null,
      url: null,
      marketplace,
      reason: reason('listed', `Dynadot listing type ${type || 'unknown'}`),
    };
  }
}
