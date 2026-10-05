import { parseAmount } from '../../pricing/money.js';
import { isRecord, parseJson, str, tryJson } from './http.js';
import { ProviderError, draft, reason, type AdapterContext, type CheckResult, type DomainParts, type ProviderAdapter } from './types.js';
import type { ProviderHttpResponse } from '../transport.js';

/**
 * Spaceship API v1 (https://docs.spaceship.dev/). Availability returns `result` and premium
 * operation prices only. Only the result value "available" is documented; anything else stays
 * unknown instead of being read as taken.
 */
export const SPACESHIP_BASE = 'https://spaceship.dev/api/v1';
const NAME = 'Spaceship';
const DOCS = 'https://docs.spaceship.dev/';

function headers(ctx: AdapterContext) {
  return { 'X-API-Key': ctx.credentials.apiKey ?? '', 'X-API-Secret': ctx.credentials.apiSecret ?? '', Accept: 'application/json' };
}

function detail(response: ProviderHttpResponse): string | null {
  const body = tryJson(response);
  return isRecord(body) ? (str(body.detail) ?? str(body.title)) : null;
}

export interface SpaceshipAvailability {
  result: string | null;
  premium: { operation: string; amount: string | null; currency: string | null }[];
}

/** Pure parser for GET /domains/{domain}/available, exported for fixture tests. */
export function parseSpaceshipAvailability(body: unknown, domain: string): SpaceshipAvailability {
  if (!isRecord(body)) throw new ProviderError('bad_response', 'Spaceship availability response is not an object');
  if (typeof body.domain === 'string' && body.domain.toLowerCase() !== domain) {
    throw new ProviderError('bad_response', 'Spaceship answered for a different domain');
  }
  const pricing = Array.isArray(body.premiumPricing) ? body.premiumPricing.filter(isRecord) : [];
  return {
    result: str(body.result),
    premium: pricing.map((p) => ({
      operation: (str(p.operation) ?? '').toLowerCase(),
      amount: parseAmount(p.price),
      currency: typeof p.currency === 'string' ? p.currency.toUpperCase() : null,
    })),
  };
}

function toCheck(parsed: SpaceshipAvailability): CheckResult {
  const premium = parsed.premium.length > 0 ? true : null;
  if (parsed.result === 'available') return { status: 'available', premium, reason: reason('provider_available', 'Spaceship reported result=available') };
  return {
    status: 'unknown',
    premium,
    reason: reason('undocumented_result', `Spaceship returned result=${parsed.result ?? 'none'}, a value its documentation does not define`),
  };
}

export class SpaceshipAdapter implements ProviderAdapter {
  readonly providerId = 'spaceship';
  readonly testOperation = 'GET /v1/domains?take=1&skip=0';

  async testCredentials(ctx: AdapterContext) {
    const response = await ctx.http.request({ method: 'GET', url: `${SPACESHIP_BASE}/domains?take=1&skip=0`, headers: headers(ctx) });
    ctx.http.assertOk(response, NAME, detail(response));
    const body = parseJson(response, NAME);
    if (!isRecord(body) || !Array.isArray(body.items)) throw new ProviderError('bad_response', 'Spaceship domain list has no items array');
    return { operation: this.testOperation, message: 'Spaceship accepted the API key and secret (listing owned domains succeeded).' };
  }

  private async availability(ctx: AdapterContext, domain: DomainParts) {
    const response = await ctx.http.request({ method: 'GET', url: `${SPACESHIP_BASE}/domains/${encodeURIComponent(domain.ascii)}/available`, headers: headers(ctx) });
    ctx.http.assertOk(response, NAME, detail(response));
    return parseSpaceshipAvailability(parseJson(response, NAME), domain.ascii);
  }

  async check(ctx: AdapterContext, domain: DomainParts) {
    return toCheck(await this.availability(ctx, domain));
  }

  async quote(ctx: AdapterContext, domain: DomainParts) {
    const parsed = await this.availability(ctx, domain);
    const check = toCheck(parsed);
    const register = parsed.premium.find((p) => p.operation === 'register');
    // Standard names carry no price in the API; only premium operation prices can become an offer.
    if (check.status !== 'available' || !register?.currency || !register.amount) return { check, offers: [] };
    const renew = parsed.premium.find((p) => p.operation === 'renew' && p.currency === register.currency);
    const transfer = parsed.premium.find((p) => p.operation === 'transfer' && p.currency === register.currency);
    return {
      check,
      offers: [
        draft({
          kind: 'exact_quote',
          currency: register.currency,
          // Operation prices carry no documented term, so they are kept as premium amounts only:
          // registration and renewal terms stay unknown and the offer cannot rank as a total.
          registration: { amount: null, years: 1 },
          renewal: { amount: null, years: 1 },
          transfer: { amount: null, includesYears: null },
          premium: { status: 'confirmed', registration: register.amount, renewal: null },
          source: {
            label: `Spaceship premiumPricing (operation prices, term undocumented: register ${register.amount}${renew?.amount ? `, renew ${renew.amount}` : ''}${transfer?.amount ? `, transfer ${transfer.amount}` : ''} ${register.currency})`,
            url: DOCS,
          },
        }),
      ],
    };
  }
}
