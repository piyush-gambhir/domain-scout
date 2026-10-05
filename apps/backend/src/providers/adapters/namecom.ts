import { domainToASCII } from 'node:url';
import { compare, parseAmount } from '../../pricing/money.js';
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
  type ListingResult,
  type OfferDraft,
  type ProviderAdapter,
} from './types.js';

/**
 * Name.com Core API v1 (https://docs.name.com/api/v1/overview, spec 1.35.0). HTTP Basic auth with
 * username and API token. Prices are USD. `/v4` is legacy and not used.
 */
export const NAMECOM_BASE = 'https://api.name.com/core/v1';
const NAME = 'Name.com';
const CHECK_DOC = 'https://docs.name.com/api/v1/reference/domains/check-availability';
const PRICING_DOC = 'https://docs.name.com/api/v1/reference/domains/get-pricing-for-domain';
const TLD_DOC = 'https://docs.name.com/api/v1/reference/tld-pricing/tld-price-list';

const ACQUISITION_TYPES = new Set(['aftermarket_i', 'aftermarket_s', 'aftermarket_b', 'expiring']);

function headers(ctx: AdapterContext, json = false): Record<string, string> {
  const basic = Buffer.from(`${ctx.credentials.username ?? ''}:${ctx.credentials.apiToken ?? ''}`).toString('base64');
  return { Authorization: `Basic ${basic}`, Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

function detail(response: ProviderHttpResponse): string | null {
  const body = tryJson(response);
  return isRecord(body) ? [str(body.message), str(body.details)].filter(Boolean).join(': ') || null : null;
}

export interface NameComResult {
  purchasable: boolean | null;
  premium: boolean | null;
  purchaseType: string | null;
  purchasePrice: string | null;
  renewalPrice: string | null;
  reason: string | null;
}

/** Pure parser for checkAvailability (result order is not guaranteed), exported for fixture tests. */
export function parseNameComCheck(body: unknown, domain: string): NameComResult | null {
  if (!isRecord(body) || !Array.isArray(body.results)) throw new ProviderError('bad_response', 'Name.com checkAvailability has no results array');
  const hit = body.results.find((r) => isRecord(r) && typeof r.domainName === 'string' && r.domainName.toLowerCase() === domain);
  if (!isRecord(hit)) return null;
  return {
    purchasable: typeof hit.purchasable === 'boolean' ? hit.purchasable : null,
    premium: typeof hit.premium === 'boolean' ? hit.premium : null,
    purchaseType: str(hit.purchaseType),
    purchasePrice: parseAmount(hit.purchasePrice),
    renewalPrice: parseAmount(hit.renewalPrice),
    reason: str(hit.reason),
  };
}

function toCheck(parsed: NameComResult | null): CheckResult {
  if (!parsed) return { status: 'unknown', premium: null, reason: reason('missing_result', 'Name.com returned no result for this name') };
  if (parsed.purchasable === null) return { status: 'unknown', premium: parsed.premium, reason: reason('provider_unclear', 'Name.com did not state purchasability') };
  if (!parsed.purchasable) {
    return { status: 'unavailable', premium: parsed.premium, reason: reason('provider_unavailable', `Name.com: not purchasable${parsed.reason ? ` (${parsed.reason})` : ''}`) };
  }
  if (parsed.purchaseType && parsed.purchaseType !== 'registration') {
    // Purchasable only as an acquisition: not available for new registration.
    return {
      status: 'unavailable',
      premium: parsed.premium,
      reason: reason('acquisition_only', `Name.com offers this name as ${parsed.purchaseType}, not as a new registration`),
    };
  }
  return { status: 'available', premium: parsed.premium, reason: reason('provider_available', 'Name.com: purchasable as a registration') };
}

export interface NameComPricing {
  premium: boolean | null;
  purchasePrice: string | null;
  renewalPrice: string | null;
  transferPrice: string | null;
}

export function parseNameComPricing(body: unknown): NameComPricing {
  if (!isRecord(body)) throw new ProviderError('bad_response', 'Name.com getPricing response is not an object');
  return {
    premium: typeof body.premium === 'boolean' ? body.premium : null,
    purchasePrice: parseAmount(body.purchasePrice),
    renewalPrice: parseAmount(body.renewalPrice),
    transferPrice: parseAmount(body.transferPrice),
  };
}

/** Pure parser for one tldpricing page, exported for fixture tests. */
export function parseNameComTldPricing(body: unknown): { entries: CatalogEntry[]; suffixes: string[]; nextPage: number | null } {
  if (!isRecord(body) || !Array.isArray(body.pricing)) throw new ProviderError('bad_response', 'Name.com tldpricing has no pricing array');
  const entries: CatalogEntry[] = [];
  const suffixes: string[] = [];
  for (const raw of body.pricing) {
    if (!isRecord(raw) || typeof raw.tld !== 'string') continue;
    if (raw.duration !== undefined && raw.duration !== 1) continue;
    const suffix = domainToASCII(raw.tld.toLowerCase().replace(/^\./, ''));
    if (!suffix) continue;
    const registration = parseAmount(raw.registrationPrice);
    const original = parseAmount(raw.registrationOriginalPrice);
    const renewal = parseAmount(raw.renewalPrice);
    const transfer = parseAmount(raw.transferInPrice);
    if (registration === null && renewal === null && transfer === null) continue;
    suffixes.push(suffix);
    const promotional = registration !== null && original !== null && compare(registration, original) < 0;
    entries.push({
      suffix,
      ...draft({
        kind: 'published',
        currency: 'USD',
        registration: { amount: registration, years: 1 },
        renewal: { amount: renewal, years: 1 },
        transfer: { amount: transfer, includesYears: null },
        promotional,
        promotion: promotional
          ? { description: `Account price below the original price of ${original} USD`, requiresTermYears: null, restrictions: null, expiresAt: null, eligibilityVerified: true }
          : null,
        source: { label: 'Name.com tldpricing (account prices, non-premium)', url: TLD_DOC },
      }),
    });
  }
  const next = typeof body.nextPage === 'number' && body.nextPage > 0 ? body.nextPage : null;
  return { entries, suffixes, nextPage: next };
}

export class NameComAdapter implements ProviderAdapter {
  readonly providerId = 'namecom';
  readonly testOperation = 'GET /core/v1/hello';

  async testCredentials(ctx: AdapterContext) {
    const response = await ctx.http.request({ method: 'GET', url: `${NAMECOM_BASE}/hello`, headers: headers(ctx) });
    ctx.http.assertOk(response, NAME, detail(response));
    const body = parseJson(response, NAME);
    if (!isRecord(body) || typeof body.username !== 'string') throw new ProviderError('bad_response', 'Name.com hello returned no username');
    return { operation: this.testOperation, message: 'Name.com accepted the username and API token (hello succeeded).' };
  }

  async catalog(ctx: AdapterContext): Promise<CatalogResult> {
    const entries: CatalogEntry[] = [];
    const suffixes: string[] = [];
    let page: number | null = 1;
    for (let guard = 0; page !== null && guard < 50; guard++) {
      const params = new URLSearchParams({ perPage: '1000', page: String(page), duration: '1' });
      const response = await ctx.http.request({ method: 'GET', url: `${NAMECOM_BASE}/tldpricing?${params}`, headers: headers(ctx) });
      ctx.http.assertOk(response, NAME, detail(response));
      const parsed = parseNameComTldPricing(parseJson(response, NAME));
      entries.push(...parsed.entries);
      suffixes.push(...parsed.suffixes);
      page = parsed.nextPage !== null && parsed.nextPage !== page ? parsed.nextPage : null;
    }
    return { suffixes, entries, source: 'Name.com tldpricing' };
  }

  private async checkAvailability(ctx: AdapterContext, domain: DomainParts) {
    const response = await ctx.http.request({
      method: 'POST',
      // The colon is part of the path and must not be percent-encoded.
      url: `${NAMECOM_BASE}/domains:checkAvailability`,
      headers: headers(ctx, true),
      body: JSON.stringify({ domainNames: [domain.ascii] }),
    });
    if (response.status === 422) throw new ProviderError('unsupported', `Name.com cannot check this extension: ${detail(response) ?? 'no valid domains'}`, { status: 422 });
    ctx.http.assertOk(response, NAME, detail(response));
    return parseNameComCheck(parseJson(response, NAME), domain.ascii);
  }

  private async pricing(ctx: AdapterContext, domain: DomainParts) {
    const response = await ctx.http.request({
      method: 'GET',
      url: `${NAMECOM_BASE}/domains/${encodeURIComponent(domain.ascii)}:getPricing?years=1`,
      headers: headers(ctx),
    });
    ctx.http.assertOk(response, NAME, detail(response));
    return parseNameComPricing(parseJson(response, NAME));
  }

  async check(ctx: AdapterContext, domain: DomainParts) {
    return toCheck(await this.checkAvailability(ctx, domain));
  }

  async quote(ctx: AdapterContext, domain: DomainParts) {
    const parsed = await this.checkAvailability(ctx, domain);
    const check = toCheck(parsed);
    if (!parsed?.purchasable) return { check, offers: [] };
    if (parsed.purchaseType && ACQUISITION_TYPES.has(parsed.purchaseType)) {
      return { check, offers: parsed.purchasePrice ? [this.acquisitionOffer(parsed)] : [] };
    }
    if (check.status !== 'available') return { check, offers: [] };
    const price = await this.pricing(ctx, domain);
    const premium = price.premium ?? parsed.premium;
    return {
      check,
      offers: [
        draft({
          kind: 'exact_quote',
          currency: 'USD',
          // purchasePrice is the total for years=1; null means a 1-year registration is not offered.
          registration: { amount: price.purchasePrice, years: 1 },
          renewal: { amount: price.renewalPrice, years: 1 },
          transfer: { amount: price.transferPrice, includesYears: null },
          premium: {
            status: premium === null ? 'unknown' : premium ? 'confirmed' : 'not_premium',
            registration: premium ? price.purchasePrice : null,
            renewal: premium ? price.renewalPrice : null,
          },
          source: { label: 'Name.com checkAvailability + getPricing (years=1)', url: PRICING_DOC },
        }),
      ],
    };
  }

  private acquisitionOffer(parsed: NameComResult): OfferDraft {
    return draft({
      purchasePath: 'aftermarket',
      kind: 'exact_quote',
      currency: 'USD',
      // A flat acquisition fee: years does not multiply it or guarantee a registration term.
      registration: { amount: parsed.purchasePrice, years: 1 },
      renewal: { amount: parsed.renewalPrice, years: 1 },
      premium: { status: parsed.premium ? 'confirmed' : 'unknown', registration: parsed.purchasePrice, renewal: null },
      source: { label: `Name.com checkAvailability (${parsed.purchaseType}, flat acquisition fee)`, url: CHECK_DOC },
    });
  }

  async transfer(ctx: AdapterContext, domain: DomainParts) {
    const price = await this.pricing(ctx, domain);
    if (price.transferPrice === null) return { offers: [], reason: reason('no_transfer_price', 'Name.com returned no transfer price (transfers not accepted for this name)') };
    return {
      offers: [
        draft({
          purchasePath: 'transfer',
          kind: 'exact_quote',
          currency: 'USD',
          transfer: { amount: price.transferPrice, includesYears: null },
          renewal: { amount: price.renewalPrice, years: 1 },
          premium: { status: price.premium === null ? 'unknown' : price.premium ? 'confirmed' : 'not_premium', registration: null, renewal: null },
          source: { label: 'Name.com getPricing (transferPrice)', url: PRICING_DOC },
        }),
      ],
      reason: reason('transfer_price', 'Name.com getPricing stated a transfer price'),
    };
  }

  async aftermarket(ctx: AdapterContext, domain: DomainParts): Promise<ListingResult> {
    const parsed = await this.checkAvailability(ctx, domain);
    const marketplace = 'Name.com';
    if (parsed?.purchasable && parsed.purchaseType && ACQUISITION_TYPES.has(parsed.purchaseType)) {
      return {
        status: 'fixed_price',
        price: parsed.purchasePrice ? { amount: parsed.purchasePrice, currency: 'USD' } : null,
        url: null,
        marketplace,
        reason: reason('listed', `Offered as ${parsed.purchaseType} acquisition`),
      };
    }
    if (!parsed) return { status: 'unknown', price: null, url: null, marketplace, reason: reason('missing_result', 'Name.com returned no result for this name') };
    if (parsed.purchasable && parsed.purchaseType === 'backorder') {
      return { status: 'unknown', price: null, url: null, marketplace, reason: reason('backorder', 'Name.com offers a backorder, which is not a listing') };
    }
    if (parsed.purchasable && parsed.purchaseType && parsed.purchaseType !== 'registration') {
      return { status: 'unknown', price: null, url: null, marketplace, reason: reason('unrecognized_type', `Name.com purchase type ${parsed.purchaseType} is not a known listing type`) };
    }
    return { status: 'not_listed', price: null, url: null, marketplace, reason: reason('not_listed', 'Name.com returned no acquisition offer for this name') };
  }
}
