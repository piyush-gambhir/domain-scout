import { parseAmount } from '../../pricing/money.js';
import type { ProviderHttpResponse } from '../transport.js';
import { childText, findAll, findFirst, parseXml, XmlError, type XmlNode } from './xml.js';
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
 * NameSilo API (https://www.namesilo.com/api-reference). All operations are GET with
 * `version=1&type=xml&key=...`; automated use goes through /apibatch. The official reference
 * renders only behind a browser challenge, so this adapter follows the documented request format
 * and the simplified XML fragments in NameSilo's own walkthrough. The surrounding envelope and
 * reply codes are not confirmed, so every capability stays at the documented level.
 */
export const NAMESILO_BASE = 'https://www.namesilo.com/apibatch';
const NAME = 'NameSilo';
const DOC = 'https://www.namesilo.com/blog/en/building-a-domain-search-tool-with-a-registrar-api';

function url(ctx: AdapterContext, operation: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ version: '1', type: 'xml', key: ctx.credentials.apiKey ?? '', ...extra });
  return `${NAMESILO_BASE}/${operation}?${params}`;
}

function parse(ctx: AdapterContext, response: ProviderHttpResponse): XmlNode {
  ctx.http.assertOk(response, NAME);
  try {
    return parseXml(response.body);
  } catch (error) {
    throw new ProviderError('bad_response', `NameSilo returned malformed XML (${(error as XmlError).message})`, { status: response.status });
  }
}

/**
 * Called when the expected data is missing. Reply codes are not confirmed by the readable
 * documentation, so success is judged by the presence of data and failures report the reply text.
 */
function replyError(ctx: AdapterContext, root: XmlNode, what: string): ProviderError {
  const code = findFirst(root, 'code')?.text.trim() ?? '';
  const detail = findFirst(root, 'detail')?.text.trim() ?? '';
  const message = ctx.http.scrub([code, detail].filter(Boolean).join(' ')) || 'no reply detail';
  if (/api key|invalid key|not authori[sz]ed|ip address|permission/i.test(detail)) {
    return new ProviderError('auth', `NameSilo refused the API key (${message}). Check the key and its IP restrictions in the API Manager.`);
  }
  return new ProviderError('bad_response', `NameSilo returned no ${what} (${message})`);
}

/** Pure parser for getPrices: elements with registration/renew/transfer children, named by TLD. */
export function parseNameSiloPrices(root: XmlNode): Map<string, { registration: string | null; renew: string | null; transfer: string | null }> {
  const out = new Map<string, { registration: string | null; renew: string | null; transfer: string | null }>();
  const walk = (node: XmlNode) => {
    for (const child of node.children) {
      const registration = childText(child, 'registration');
      if (registration !== null) {
        const tld = child.name.toLowerCase();
        if (/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(tld)) {
          out.set(tld, { registration: parseAmount(registration), renew: parseAmount(childText(child, 'renew')), transfer: parseAmount(childText(child, 'transfer')) });
        }
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

export interface NameSiloAvailability {
  bucket: 'available' | 'unavailable' | 'invalid' | null;
  price: string | null;
}

/** Pure parser for checkRegisterAvailability buckets, exported for fixture tests. */
export function parseNameSiloAvailability(root: XmlNode, domain: string): NameSiloAvailability {
  for (const bucket of ['available', 'unavailable', 'invalid'] as const) {
    for (const group of findAll(root, bucket)) {
      const hit = group.children.find((d) => d.name === 'domain' && d.text.trim().toLowerCase() === domain);
      if (hit) return { bucket, price: parseAmount(hit.attrs.price) };
    }
  }
  return { bucket: null, price: null };
}

function toCheck(parsed: NameSiloAvailability): CheckResult {
  switch (parsed.bucket) {
    case 'available':
      return { status: 'available', premium: null, reason: reason('provider_available', 'NameSilo listed the name under available') };
    case 'unavailable':
      return { status: 'unavailable', premium: null, reason: reason('provider_unavailable', 'NameSilo listed the name under unavailable') };
    case 'invalid':
      return { status: 'unknown', premium: null, reason: reason('provider_invalid', 'NameSilo listed the name as invalid') };
    default:
      return { status: 'unknown', premium: null, reason: reason('missing_result', 'NameSilo returned no result for this name') };
  }
}

export class NameSiloAdapter implements ProviderAdapter {
  readonly providerId = 'namesilo';
  readonly testOperation = 'getPrices';

  /** Uses the account price list: no candidate name, and success means the key returned account data. */
  async testCredentials(ctx: AdapterContext) {
    const response = await ctx.http.request({ method: 'GET', url: url(ctx, 'getPrices') });
    const root = parse(ctx, response);
    const prices = parseNameSiloPrices(root);
    if (prices.size === 0) throw replyError(ctx, root, 'account prices, so the key could not be confirmed');
    return { operation: this.testOperation, message: 'NameSilo returned the account price list for this key.' };
  }

  async catalog(ctx: AdapterContext): Promise<CatalogResult> {
    const response = await ctx.http.request({ method: 'GET', url: url(ctx, 'getPrices'), maxBytes: 16 * 1024 * 1024 });
    const root = parse(ctx, response);
    const prices = parseNameSiloPrices(root);
    if (prices.size === 0) throw replyError(ctx, root, 'prices');
    const entries: CatalogEntry[] = [...prices].map(([suffix, p]) => ({
      suffix,
      ...draft({
        kind: 'published',
        currency: 'USD',
        registration: { amount: p.registration, years: 1 },
        renewal: { amount: p.renew, years: 1 },
        transfer: { amount: p.transfer, includesYears: null },
        source: { label: 'NameSilo getPrices (USD assumed; envelope unconfirmed)', url: DOC },
      }),
    }));
    return { suffixes: [...prices.keys()], entries, source: 'NameSilo getPrices' };
  }

  private async availability(ctx: AdapterContext, domain: DomainParts) {
    const response = await ctx.http.request({ method: 'GET', url: url(ctx, 'checkRegisterAvailability', { domains: domain.ascii }) });
    const root = parse(ctx, response);
    const parsed = parseNameSiloAvailability(root, domain.ascii);
    if (parsed.bucket === null && !findFirst(root, 'available') && !findFirst(root, 'unavailable')) throw replyError(ctx, root, 'availability result');
    return parsed;
  }

  async check(ctx: AdapterContext, domain: DomainParts) {
    return toCheck(await this.availability(ctx, domain));
  }

  async quote(ctx: AdapterContext, domain: DomainParts) {
    const parsed = await this.availability(ctx, domain);
    const check = toCheck(parsed);
    if (check.status !== 'available' || parsed.price === null) return { check, offers: [] };
    return {
      check,
      offers: [
        draft({
          kind: 'exact_quote',
          currency: 'USD',
          registration: { amount: parsed.price, years: 1 },
          source: { label: 'NameSilo checkRegisterAvailability price (term, renewal and premium status unconfirmed)', url: DOC },
        }),
      ],
    };
  }
}
