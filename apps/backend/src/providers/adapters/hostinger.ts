import { fromMinorUnits } from '../../pricing/money.js';
import type { ProviderHttpResponse } from '../transport.js';
import { isRecord, parseJson, str, tryJson } from './http.js';
import {
  ProviderError,
  draft,
  reason,
  type AdapterContext,
  type CatalogEntry,
  type CatalogResult,
  type CheckResult,
  type DomainParts,
  type ProviderAdapter,
} from './types.js';

/**
 * Hostinger API (https://docs.hostinger.com/api-reference/overview; official SDK docs read
 * 2026-10-05). Availability has no price fields. The billing catalog lists items with prices in
 * cents per period; Hostinger does not document which action a price maps to, so catalog prices are
 * published references only and never an exact-name or premium quote.
 */
export const HOSTINGER_BASE = 'https://developers.hostinger.com';
const NAME = 'Hostinger';
const CATALOG_DOC = 'https://github.com/hostinger/api-python-sdk/blob/main/docs/BillingCatalogApi.md';

function headers(ctx: AdapterContext, json = false): Record<string, string> {
  return { Authorization: `Bearer ${ctx.credentials.apiToken ?? ''}`, Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

function detail(response: ProviderHttpResponse): string | null {
  const body = tryJson(response);
  return isRecord(body) ? str(body.message) : null;
}

/** Pure parser for the billing catalog (category DOMAIN), exported for fixture tests. */
export function parseHostingerCatalog(body: unknown): { entries: CatalogEntry[]; suffixes: string[] } {
  if (!Array.isArray(body)) throw new ProviderError('bad_response', 'Hostinger catalog response is not an array');
  const entries: CatalogEntry[] = [];
  const suffixes: string[] = [];
  for (const item of body) {
    if (!isRecord(item) || (str(item.category) ?? '').toUpperCase() !== 'DOMAIN') continue;
    const name = str(item.name) ?? '';
    // Domain items are named after the extension, e.g. ".COM Domain"; transfer products are skipped.
    const match = /^\.([a-z0-9-]+(?:\.[a-z0-9-]+)*)\b/i.exec(name.trim());
    if (!match || /transfer/i.test(name)) continue;
    const suffix = match[1]!.toLowerCase();
    const prices = Array.isArray(item.prices) ? item.prices.filter(isRecord) : [];
    const yearly = prices
      .filter((p) => /^year/i.test(str(p.period_unit) ?? '') && typeof p.period === 'number' && p.period >= 1)
      .sort((a, b) => (a.period as number) - (b.period as number));
    const price = yearly[0];
    const currency = price && typeof price.currency === 'string' ? price.currency.toUpperCase() : null;
    if (!suffixes.includes(suffix)) suffixes.push(suffix);
    if (!price || !currency || price.first_period_price === undefined || price.first_period_price === null) continue;
    const years = price.period as number;
    entries.push({
      suffix,
      ...draft({
        kind: 'published',
        currency,
        // first_period_price is the documented first-period price; whether `price` is the renewal
        // price is undocumented, so renewal stays unknown and the regular price is only labeled.
        registration: { amount: fromMinorUnits(price.first_period_price, currency), years },
        renewal: { amount: null, years },
        source: {
          label: `Hostinger billing catalog: first-period price; regular price ${fromMinorUnits(price.price, currency) ?? 'unknown'} ${currency} per ${years}-year period (renewal mapping undocumented)`,
          url: CATALOG_DOC,
        },
      }),
    });
  }
  return { entries, suffixes };
}

/** Pure parser for availability, exported for fixture tests. */
export function parseHostingerAvailability(body: unknown, domain: string): CheckResult {
  if (!Array.isArray(body)) throw new ProviderError('bad_response', 'Hostinger availability response is not an array');
  const hit = body.find((r) => isRecord(r) && r.is_alternative !== true && typeof r.domain === 'string' && r.domain.toLowerCase() === domain);
  if (!isRecord(hit) || typeof hit.is_available !== 'boolean') {
    return { status: 'unknown', premium: null, reason: reason('missing_result', 'Hostinger returned no availability for this name') };
  }
  const restriction = str(hit.restriction);
  const note = restriction ? ` Registration rules: ${restriction}` : '';
  return hit.is_available
    ? { status: 'available', premium: null, reason: reason('provider_available', `Hostinger reported is_available=true (availability only, no price).${note}`) }
    : { status: 'unavailable', premium: null, reason: reason('provider_unavailable', `Hostinger reported is_available=false.${note}`) };
}

export class HostingerAdapter implements ProviderAdapter {
  readonly providerId = 'hostinger';
  readonly testOperation = 'GET /api/billing/v1/catalog?category=DOMAIN';

  private async fetchCatalog(ctx: AdapterContext, name?: string) {
    const params = new URLSearchParams({ category: 'DOMAIN' });
    if (name) params.set('name', name);
    const response = await ctx.http.request({ method: 'GET', url: `${HOSTINGER_BASE}/api/billing/v1/catalog?${params}`, headers: headers(ctx), maxBytes: 16 * 1024 * 1024 });
    ctx.http.assertOk(response, NAME, detail(response));
    return parseJson(response, NAME);
  }

  async testCredentials(ctx: AdapterContext) {
    const body = await this.fetchCatalog(ctx);
    if (!Array.isArray(body)) throw new ProviderError('bad_response', 'Hostinger catalog response is not an array');
    return { operation: this.testOperation, message: 'Hostinger accepted the API token (billing catalog read succeeded).' };
  }

  async catalog(ctx: AdapterContext): Promise<CatalogResult> {
    const parsed = parseHostingerCatalog(await this.fetchCatalog(ctx));
    return { ...parsed, source: 'Hostinger billing catalog' };
  }

  async check(ctx: AdapterContext, domain: DomainParts) {
    const response = await ctx.http.request({
      method: 'POST',
      url: `${HOSTINGER_BASE}/api/domains/v1/availability`,
      headers: headers(ctx, true),
      body: JSON.stringify({ domain: domain.label, tlds: [domain.suffix], with_alternatives: false }),
    });
    if (response.status === 422) throw new ProviderError('unsupported', `Hostinger cannot check this extension: ${detail(response) ?? 'validation failed'}`, { status: 422 });
    ctx.http.assertOk(response, NAME, detail(response));
    return parseHostingerAvailability(parseJson(response, NAME), domain.ascii);
  }

  /**
   * Availability plus the catalog price for the extension. The price is recorded as a published,
   * suffix-level price with unknown premium status: Hostinger offers no exact-name quote.
   */
  async quote(ctx: AdapterContext, domain: DomainParts) {
    const check = await this.check(ctx, domain);
    if (check.status !== 'available') return { check, offers: [] };
    const catalog = parseHostingerCatalog(await this.fetchCatalog(ctx, `.${domain.suffix.toUpperCase()}*`));
    const entry = catalog.entries.find((e) => e.suffix === domain.suffix);
    if (!entry) return { check, offers: [] };
    const { suffix: _suffix, ...offer } = entry;
    return {
      check,
      offers: [{ ...offer, source: { label: `${offer.source.label}; extension price, not an exact-name quote`, url: offer.source.url } }],
    };
  }
}
