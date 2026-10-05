import { compare, isZero, parseAmount } from '../../pricing/money.js';
import type { ProviderHttpResponse } from '../transport.js';
import { findAll, findFirst, parseXml, XmlError, type XmlNode } from './xml.js';
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
 * Namecheap XML API (https://www.namecheap.com/support/api/intro/). Every call is a GET with the
 * global parameters ApiUser, ApiKey, UserName, ClientIp and Command. Errors come back as
 * `ApiResponse Status="ERROR"` with HTTP 200, so the envelope decides success.
 */
export const NAMECHEAP_BASE = 'https://api.namecheap.com/xml.response';
const NAME = 'Namecheap';
const CHECK_DOC = 'https://www.namecheap.com/support/api/methods/domains/check/';
const PRICING_DOC = 'https://www.namecheap.com/support/api/methods/users/get-pricing/';

/** Error texts that point at access configuration rather than the request. */
const AUTH_PATTERN = /api ?key|apiuser|user ?name|client ?ip|request ?ip|whitelist|api access|not enabled|authenticat/i;

function url(ctx: AdapterContext, command: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    ApiUser: ctx.credentials.apiUser ?? '',
    ApiKey: ctx.credentials.apiKey ?? '',
    UserName: ctx.credentials.userName || ctx.credentials.apiUser || '',
    ClientIp: ctx.credentials.clientIp ?? '',
    Command: command,
    ...extra,
  });
  return `${NAMECHEAP_BASE}?${params.toString()}`;
}

/** Parses the envelope and returns CommandResponse, mapping ERROR responses. */
function commandResponse(ctx: AdapterContext, response: ProviderHttpResponse): XmlNode {
  // Namecheap answers HTTP 200 with an envelope; any other status keeps its HTTP meaning first.
  if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) ctx.http.assertOk(response, NAME);
  let root: XmlNode;
  try {
    root = parseXml(response.body);
  } catch (error) {
    ctx.http.assertOk(response, NAME);
    throw new ProviderError('bad_response', `Namecheap returned malformed XML (${(error as XmlError).message})`, { status: response.status });
  }
  if (root.name !== 'ApiResponse') {
    ctx.http.assertOk(response, NAME);
    throw new ProviderError('bad_response', 'Namecheap response has no ApiResponse element', { status: response.status });
  }
  if ((root.attrs.Status ?? '').toUpperCase() === 'ERROR') {
    const errors = findAll(root, 'Error').map((e) => `${e.attrs.Number ? `${e.attrs.Number}: ` : ''}${e.text.trim()}`);
    const message = ctx.http.scrub(errors.join('; ') || 'Namecheap returned Status=ERROR');
    if (AUTH_PATTERN.test(message)) {
      throw new ProviderError(
        'auth',
        `Namecheap refused API access (${message}). Check the API user, key, enabled API access and the whitelisted client IP.`,
        { status: response.status },
      );
    }
    if (/too many|rate limit/i.test(message)) {
      throw new ProviderError('rate_limited', `Namecheap rate limit reached (${message})`, { status: response.status, retryAt: ctx.http.retryAt(response, 60) });
    }
    throw new ProviderError('rejected', `Namecheap rejected the request (${message})`, { status: response.status });
  }
  ctx.http.assertOk(response, NAME);
  const command = findFirst(root, 'CommandResponse');
  if (!command) throw new ProviderError('bad_response', 'Namecheap response has no CommandResponse');
  return command;
}

interface TldPrices {
  currency: string | null;
  register: { price: string | null; regular: string | null };
  renew: string | null;
  transfer: string | null;
}

/** Pure parser for users.getPricing (ProductType=DOMAIN), exported for fixture tests. One-year prices per TLD. */
export function parseNamecheapPricing(command: XmlNode): Map<string, TldPrices> {
  if (!findFirst(command, 'UserGetPricingResult')) throw new ProviderError('bad_response', 'Namecheap getPricing returned no UserGetPricingResult');
  const out = new Map<string, TldPrices>();
  for (const category of findAll(command, 'ProductCategory')) {
    const action = (category.attrs.Name ?? '').toLowerCase();
    if (!['register', 'renew', 'transfer'].includes(action)) continue;
    for (const product of category.children.filter((c) => c.name === 'Product')) {
      const tld = (product.attrs.Name ?? '').toLowerCase().replace(/^\./, '');
      if (!tld) continue;
      const price = product.children.find(
        (p) => p.name === 'Price' && p.attrs.Duration === '1' && (p.attrs.DurationType ?? 'YEAR').toUpperCase() === 'YEAR',
      );
      if (!price) continue;
      const entry = out.get(tld) ?? { currency: null, register: { price: null, regular: null }, renew: null, transfer: null };
      // YourPrice is the account's price; Price is the list price when YourPrice is absent.
      const amount = parseAmount(price.attrs.YourPrice) ?? parseAmount(price.attrs.Price);
      entry.currency = entry.currency ?? price.attrs.Currency ?? null;
      if (action === 'register') entry.register = { price: amount, regular: parseAmount(price.attrs.RegularPrice) };
      if (action === 'renew') entry.renew = amount;
      if (action === 'transfer') entry.transfer = amount;
      out.set(tld, entry);
    }
  }
  return out;
}

export interface NamecheapCheck {
  domain: string;
  available: boolean | null;
  errorNo: string;
  description: string;
  isPremium: boolean | null;
  premiumRegistration: string | null;
  premiumRenewal: string | null;
  premiumTransfer: string | null;
  icannFee: string | null;
  eapFee: string | null;
}

const bool = (v: string | undefined) => (v === undefined ? null : v.toLowerCase() === 'true');
/** Zero means "not reported" for these fields, never a free price. */
const nonZero = (v: string | undefined) => {
  const amount = parseAmount(v);
  return amount && !isZero(amount) ? amount : null;
};

/** Pure parser for domains.check, exported for fixture tests. */
export function parseNamecheapCheck(command: XmlNode, domain: string): NamecheapCheck | null {
  const result = findAll(command, 'DomainCheckResult').find((r) => (r.attrs.Domain ?? '').toLowerCase() === domain);
  if (!result) return null;
  const a = result.attrs;
  return {
    domain,
    available: bool(a.Available),
    errorNo: a.ErrorNo ?? '0',
    description: a.Description ?? '',
    isPremium: bool(a.IsPremiumName),
    premiumRegistration: nonZero(a.PremiumRegistrationPrice),
    premiumRenewal: nonZero(a.PremiumRenewalPrice),
    premiumTransfer: nonZero(a.PremiumTransferPrice),
    icannFee: nonZero(a.IcannFee),
    eapFee: nonZero(a.EapFee),
  };
}

function toCheckResult(check: NamecheapCheck | null): CheckResult {
  if (!check) return { status: 'unknown', premium: null, reason: reason('missing_result', 'Namecheap returned no result for this name') };
  if (check.errorNo !== '0') {
    return { status: 'unknown', premium: check.isPremium, reason: reason('provider_error', `Namecheap check error ${check.errorNo}: ${check.description}`) };
  }
  if (check.available === null) return { status: 'unknown', premium: check.isPremium, reason: reason('provider_unclear', 'Namecheap did not state availability') };
  return check.available
    ? { status: 'available', premium: check.isPremium, reason: reason('provider_available', 'Namecheap domains.check reported Available=true') }
    : { status: 'unavailable', premium: check.isPremium, reason: reason('provider_unavailable', 'Namecheap domains.check reported Available=false') };
}

export class NamecheapAdapter implements ProviderAdapter {
  readonly providerId = 'namecheap';
  readonly testOperation = 'namecheap.users.getBalances';

  async testCredentials(ctx: AdapterContext) {
    const response = await ctx.http.request({ method: 'GET', url: url(ctx, 'namecheap.users.getBalances') });
    const command = commandResponse(ctx, response);
    if (!findFirst(command, 'UserGetBalancesResult')) throw new ProviderError('bad_response', 'Namecheap getBalances returned no UserGetBalancesResult');
    return { operation: this.testOperation, message: 'Namecheap accepted the API credentials (account balance query succeeded).' };
  }

  async catalog(ctx: AdapterContext): Promise<CatalogResult> {
    const response = await ctx.http.request({
      method: 'GET',
      url: url(ctx, 'namecheap.users.getPricing', { ProductType: 'DOMAIN' }),
      maxBytes: 32 * 1024 * 1024,
    });
    const prices = parseNamecheapPricing(commandResponse(ctx, response));
    const entries: CatalogEntry[] = [];
    for (const [suffix, p] of prices) {
      if (!p.currency) continue;
      entries.push({ suffix, ...this.priceDraft(p, 'published', 'Namecheap users.getPricing (account prices)') });
    }
    return { suffixes: [...prices.keys()], entries, source: 'namecheap.users.getPricing' };
  }

  private priceDraft(p: TldPrices, kind: 'published' | 'exact_quote', label: string) {
    const promotional = p.register.price !== null && p.register.regular !== null && compare(p.register.price, p.register.regular) < 0;
    return draft({
      kind,
      currency: p.currency ?? 'USD',
      registration: { amount: p.register.price, years: 1 },
      renewal: { amount: p.renew, years: 1 },
      transfer: { amount: p.transfer, includesYears: null },
      promotional,
      promotion: promotional
        ? { description: `Account price below the regular price of ${p.register.regular}`, requiresTermYears: null, restrictions: null, expiresAt: null, eligibilityVerified: true }
        : null,
      source: { label, url: PRICING_DOC },
    });
  }

  private async runCheck(ctx: AdapterContext, domain: DomainParts) {
    const response = await ctx.http.request({ method: 'GET', url: url(ctx, 'namecheap.domains.check', { DomainList: domain.ascii }) });
    return parseNamecheapCheck(commandResponse(ctx, response), domain.ascii);
  }

  async check(ctx: AdapterContext, domain: DomainParts) {
    return toCheckResult(await this.runCheck(ctx, domain));
  }

  async quote(ctx: AdapterContext, domain: DomainParts) {
    const parsed = await this.runCheck(ctx, domain);
    const check = toCheckResult(parsed);
    if (!parsed || check.status !== 'available') return { check, offers: [] };
    // The check states premium status and premium prices; standard prices come from the account TLD price.
    const response = await ctx.http.request({
      method: 'GET',
      url: url(ctx, 'namecheap.users.getPricing', { ProductType: 'DOMAIN', ProductName: domain.suffix }),
    });
    const tld = parseNamecheapPricing(commandResponse(ctx, response)).get(domain.suffix);
    if (!tld?.currency) return { check, offers: [] };
    const base = this.priceDraft(tld, 'exact_quote', 'Namecheap domains.check + users.getPricing');
    const fees = {
      icann: parsed.icannFee,
      other: parsed.eapFee ? [{ label: 'EAP fee', amount: parsed.eapFee }] : [],
      tax: 'unknown' as const,
    };
    if (parsed.isPremium) {
      return {
        check,
        offers: [
          {
            ...base,
            registration: { amount: parsed.premiumRegistration, years: 1 },
            renewal: { amount: parsed.premiumRenewal, years: 1 },
            transfer: { amount: parsed.premiumTransfer, includesYears: null },
            premium: { status: 'confirmed' as const, registration: parsed.premiumRegistration, renewal: parsed.premiumRenewal },
            promotional: false,
            promotion: null,
            fees,
            source: { label: 'Namecheap domains.check (premium prices)', url: CHECK_DOC },
          },
        ],
      };
    }
    return {
      check,
      offers: [{ ...base, premium: { status: parsed.isPremium === false ? ('not_premium' as const) : ('unknown' as const), registration: null, renewal: null }, fees }],
    };
  }
}
