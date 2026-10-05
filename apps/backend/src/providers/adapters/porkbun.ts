import { domainToASCII } from 'node:url';
import type { Offer } from '@domain-scout/contracts';
import { parseAmount } from '../../pricing/money.js';
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
  type ProviderAdapter,
} from './types.js';
import type { ProviderHttpResponse } from '../transport.js';

/**
 * Porkbun API v3 (https://porkbun.com/api/json/v3/spec, version 3.53, read 2026-10-05).
 * Prices are USD per the documentation. Errors arrive as `{status:"ERROR", code, message}` with
 * HTTP 400, 403 or 429, so the envelope is checked before the HTTP status.
 */
export const PORKBUN_BASE = 'https://api.porkbun.com/api/json/v3';
export const PORKBUN_PRICING_URL = `${PORKBUN_BASE}/pricing/get`;
const NAME = 'Porkbun';
const SPEC = 'https://porkbun.com/api/json/v3/spec';

const AUTH_CODES = new Set(['API_KEY_REQUIRED', 'INVALID_API_KEYS_001', 'INVALID_TOKEN', 'INVALID_USER', 'IP_NOT_ALLOWED', 'DOMAIN_NOT_ALLOWED']);

function headers(ctx: AdapterContext): Record<string, string> {
  return {
    'X-API-Key': ctx.credentials.apiKey ?? '',
    'X-Secret-API-Key': ctx.credentials.secretApiKey ?? '',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/** Maps Porkbun error envelopes and statuses; returns the parsed success body. */
function successBody(ctx: AdapterContext, response: ProviderHttpResponse): Record<string, unknown> {
  const body = tryJson(response);
  if (isRecord(body) && body.status === 'ERROR') {
    const code = str(body.code) ?? '';
    const message = ctx.http.scrub(str(body.message) ?? 'Porkbun returned an error');
    if (AUTH_CODES.has(code)) {
      throw new ProviderError('auth', `Porkbun rejected the API key (${code}): ${message}. Check the key pair and any IP or domain allowlist at porkbun.com/account/api.`, {
        status: response.status,
      });
    }
    if (code === 'RATE_LIMIT_EXCEEDED' || response.status === 429) {
      const ttl = Number(body.ttlRemaining);
      const retryAt = Number.isFinite(ttl) && ttl > 0 ? new Date(ctx.now.getTime() + ttl * 1000).toISOString() : ctx.http.retryAt(response, 10);
      throw new ProviderError('rate_limited', `Porkbun rate limit reached: ${message}`, { status: response.status, retryAt });
    }
    if (code === 'INVALID_TLD') throw new ProviderError('unsupported', `Porkbun does not sell this extension: ${message}`, { status: response.status });
    // Unrecognized codes keep the HTTP meaning (401/403 auth, 5xx server error).
    ctx.http.assertOk(response, NAME, message);
    throw new ProviderError('rejected', `Porkbun rejected the request${code ? ` (${code})` : ''}: ${message}`, { status: response.status });
  }
  ctx.http.assertOk(response, NAME);
  if (!isRecord(body) || body.status !== 'SUCCESS') {
    throw new ProviderError('bad_response', 'Porkbun response did not have status SUCCESS', { status: response.status });
  }
  return body;
}

/** Coupons are listed for information only; they are never applied to a price. */
function couponPromotion(coupons: unknown): Offer['promotion'] {
  const list = Array.isArray(coupons) ? coupons : isRecord(coupons) ? Object.values(coupons) : [];
  const descriptions: string[] = [];
  for (const raw of list) {
    if (!isRecord(raw) || typeof raw.code !== 'string') continue;
    const amount = str(raw.amount);
    const unit = raw.type === 'percentage' ? '%' : ' USD';
    const firstYear = yesNo(raw.first_year_only) ? ' on the first year' : '';
    descriptions.push(`Coupon ${raw.code}${amount ? `: ${amount}${unit} off${firstYear}` : ''}`);
  }
  if (!descriptions.length) return null;
  return {
    description: `${descriptions.join('; ')} (not applied)`,
    requiresTermYears: null,
    restrictions: 'Coupon code entered at checkout; per-user limits apply',
    expiresAt: null,
    eligibilityVerified: false,
  };
}

/** Pure parser for /pricing/get, exported for fixture tests. */
export function parsePorkbunPricing(body: Record<string, unknown>): CatalogResult {
  const pricing = body.pricing;
  if (!isRecord(pricing)) throw new ProviderError('bad_response', 'Porkbun pricing response has no pricing object');
  const entries: CatalogEntry[] = [];
  const suffixes: string[] = [];
  for (const [key, raw] of Object.entries(pricing)) {
    if (!isRecord(raw)) continue;
    // Special TLDs such as Handshake names are not DNS registry suffixes.
    if (raw.specialType !== undefined) continue;
    const suffix = domainToASCII(key.replace(/^\./, '').toLowerCase());
    if (!suffix || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(suffix)) continue;
    suffixes.push(suffix);
    entries.push({
      suffix,
      ...draft({
        kind: 'published',
        currency: 'USD',
        registration: { amount: parseAmount(raw.registration), years: 1 },
        renewal: { amount: parseAmount(raw.renewal), years: 1 },
        transfer: { amount: parseAmount(raw.transfer), includesYears: null },
        promotion: couponPromotion(raw.coupons),
        publishedAt: null,
        source: { label: 'Porkbun public pricing (/pricing/get)', url: SPEC },
      }),
    });
  }
  return { suffixes, entries, source: PORKBUN_PRICING_URL };
}

/** Pure parser for /domain/checkDomain, exported for fixture tests. */
export function parsePorkbunCheck(body: Record<string, unknown>) {
  const response = body.response;
  if (!isRecord(response)) throw new ProviderError('bad_response', 'Porkbun checkDomain response has no response object');
  const avail = yesNo(response.avail);
  const premium = yesNo(response.premium);
  const additional = isRecord(response.additional) ? response.additional : {};
  const renewal = isRecord(additional.renewal) ? additional.renewal : {};
  const transfer = isRecord(additional.transfer) ? additional.transfer : {};
  const minDuration = typeof response.minDuration === 'number' && response.minDuration >= 1 ? Math.floor(response.minDuration) : null;
  return {
    avail,
    premium,
    price: parseAmount(response.price),
    regularPrice: parseAmount(response.regularPrice),
    firstYearPromo: yesNo(response.firstYearPromo) === true,
    minDuration,
    renewal: parseAmount(renewal.price),
    transfer: parseAmount(transfer.price),
  };
}

function checkResult(parsed: ReturnType<typeof parsePorkbunCheck>): CheckResult {
  if (parsed.avail === null) {
    return { status: 'unknown', premium: parsed.premium, reason: reason('provider_unclear', 'Porkbun did not state availability') };
  }
  return parsed.avail
    ? { status: 'available', premium: parsed.premium, reason: reason('provider_available', 'Porkbun checkDomain reported avail=yes') }
    : { status: 'unavailable', premium: parsed.premium, reason: reason('provider_unavailable', 'Porkbun checkDomain reported avail=no') };
}

export class PorkbunAdapter implements ProviderAdapter {
  readonly providerId = 'porkbun';
  readonly testOperation = 'GET /ping';

  async testCredentials(ctx: AdapterContext) {
    const response = await ctx.http.request({ method: 'GET', url: `${PORKBUN_BASE}/ping`, headers: headers(ctx) });
    const body = successBody(ctx, response);
    if (body.credentialsValid !== true) {
      throw new ProviderError('bad_response', 'Porkbun ping succeeded but did not confirm the credentials (credentialsValid missing)');
    }
    return { operation: this.testOperation, message: 'Porkbun accepted the API key pair (ping returned credentialsValid).' };
  }

  async catalog(ctx: AdapterContext): Promise<CatalogResult> {
    // Keyless and without candidate names: the whole public price list.
    const response = await ctx.http.request({ method: 'GET', url: PORKBUN_PRICING_URL, headers: { Accept: 'application/json' }, maxBytes: 16 * 1024 * 1024 });
    const body = successBody(ctx, response);
    return parsePorkbunPricing(body);
  }

  private async checkDomain(ctx: AdapterContext, domain: DomainParts) {
    const response = await ctx.http.request({
      method: 'POST',
      url: `${PORKBUN_BASE}/domain/checkDomain/${encodeURIComponent(domain.ascii)}`,
      headers: headers(ctx),
      body: '{}',
    });
    return parsePorkbunCheck(successBody(ctx, response));
  }

  async check(ctx: AdapterContext, domain: DomainParts): Promise<CheckResult> {
    return checkResult(await this.checkDomain(ctx, domain));
  }

  async quote(ctx: AdapterContext, domain: DomainParts) {
    const parsed = await this.checkDomain(ctx, domain);
    const check = checkResult(parsed);
    if (parsed.avail !== true) return { check, offers: [] };
    const premium = parsed.premium === true;
    return {
      check,
      offers: [
        draft({
          kind: 'exact_quote',
          currency: 'USD',
          registration: { amount: parsed.price, years: 1 },
          minYears: parsed.minDuration,
          renewal: { amount: parsed.renewal, years: 1 },
          transfer: { amount: parsed.transfer, includesYears: null },
          premium: {
            status: parsed.premium === null ? 'unknown' : premium ? 'confirmed' : 'not_premium',
            registration: premium ? parsed.price : null,
            renewal: premium ? parsed.renewal : null,
          },
          promotional: parsed.firstYearPromo,
          promotion: parsed.firstYearPromo
            ? {
                description: `First-year promotional price${parsed.regularPrice ? `; regular price ${parsed.regularPrice} USD` : ''}`,
                requiresTermYears: null,
                restrictions: null,
                expiresAt: null,
                // Porkbun quoted this price for the exact name to this account; no coupon is involved.
                eligibilityVerified: true,
              }
            : null,
          source: { label: 'Porkbun checkDomain', url: SPEC },
        }),
      ],
    };
  }

  async transfer(ctx: AdapterContext, domain: DomainParts) {
    const parsed = await this.checkDomain(ctx, domain);
    if (parsed.transfer === null) {
      return { offers: [], reason: reason('no_transfer_price', 'Porkbun checkDomain returned no transfer price') };
    }
    return {
      offers: [
        draft({
          purchasePath: 'transfer',
          kind: 'exact_quote',
          currency: 'USD',
          registration: { amount: null, years: 1 },
          renewal: { amount: parsed.renewal, years: 1 },
          transfer: { amount: parsed.transfer, includesYears: null },
          premium: { status: parsed.premium === null ? 'unknown' : parsed.premium ? 'confirmed' : 'not_premium', registration: null, renewal: null },
          source: { label: 'Porkbun checkDomain (transfer price)', url: SPEC },
        }),
      ],
      reason: reason('transfer_price', 'Porkbun checkDomain stated a transfer price'),
    };
  }

  async aftermarket(ctx: AdapterContext, domain: DomainParts) {
    const response = await ctx.http.request({
      method: 'POST',
      url: `${PORKBUN_BASE}/marketplace/getAll`,
      headers: headers(ctx),
      body: JSON.stringify({ query: domain.label, tlds: [domain.suffix], sortName: 'domain' }),
    });
    const body = successBody(ctx, response);
    const listings = Array.isArray(body.domains) ? body.domains : null;
    if (!listings) throw new ProviderError('bad_response', 'Porkbun marketplace response has no domains array');
    const match = listings.find((d) => isRecord(d) && typeof d.domain === 'string' && d.domain.toLowerCase() === domain.ascii);
    if (isRecord(match)) {
      const amount = parseAmount(match.price);
      return {
        status: 'fixed_price' as const,
        price: amount ? { amount, currency: 'USD' } : null,
        url: null,
        marketplace: 'Porkbun Marketplace',
        reason: reason('listed', 'Listed on the Porkbun marketplace'),
      };
    }
    // Filtered mode caps results at 1000; a capped page without the name is not proof of absence.
    if (listings.length >= 1000) {
      return { status: 'unknown' as const, price: null, url: null, marketplace: 'Porkbun Marketplace', reason: reason('result_capped', 'Marketplace search hit its 1000-result cap') };
    }
    return { status: 'not_listed' as const, price: null, url: null, marketplace: 'Porkbun Marketplace', reason: reason('not_listed', 'Not listed on the Porkbun marketplace') };
  }
}
