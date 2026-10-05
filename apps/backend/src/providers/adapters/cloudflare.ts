import { parseAmount } from '../../pricing/money.js';
import type { ProviderHttpResponse } from '../transport.js';
import { isRecord, str, tryJson } from './http.js';
import {
  ProviderError,
  draft,
  reason,
  type AdapterContext,
  type CatalogResult,
  type CheckResult,
  type DomainParts,
  type ProviderAdapter,
} from './types.js';

/**
 * Cloudflare Registrar API (https://developers.cloudflare.com/registrar/registrar-api/, beta).
 * Responses use the `{success, errors, messages, result}` envelope; costs are decimal strings.
 */
export const CLOUDFLARE_BASE = 'https://api.cloudflare.com/client/v4';
const NAME = 'Cloudflare';
const CHECK_DOC = 'https://developers.cloudflare.com/api/resources/registrar/methods/check/';
const TRANSFER_DOC = 'https://developers.cloudflare.com/api/resources/registrar/methods/transfer_check/';

function headers(ctx: AdapterContext) {
  return { Authorization: `Bearer ${ctx.credentials.apiToken ?? ''}`, 'Content-Type': 'application/json', Accept: 'application/json' };
}

function accountPath(ctx: AdapterContext, path: string) {
  return `${CLOUDFLARE_BASE}/accounts/${encodeURIComponent(ctx.credentials.accountId ?? '')}/registrar/${path}`;
}

function envelope(ctx: AdapterContext, response: ProviderHttpResponse): Record<string, unknown> {
  const body = tryJson(response);
  const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors.filter(isRecord) : [];
  const detail = errors.map((e) => `${str(e.code) ?? ''} ${str(e.message) ?? ''}`.trim()).join('; ') || null;
  ctx.http.assertOk(response, NAME, detail);
  if (!isRecord(body)) throw new ProviderError('bad_response', 'Cloudflare response is not JSON', { status: response.status });
  if (body.success !== true) {
    const text = detail ? `: ${ctx.http.scrub(detail)}` : '';
    if (detail && /authenticat|authoriz|invalid (api )?token|permission/i.test(detail)) {
      throw new ProviderError('auth', `Cloudflare rejected the token or account access${text}`, { status: response.status });
    }
    throw new ProviderError('rejected', `Cloudflare reported success=false${text}`);
  }
  return body;
}

const UNSUPPORTED_REASONS = new Set(['extension_not_supported_via_api', 'extension_not_supported']);

export interface CloudflareCheck {
  name: string;
  registrable: boolean | null;
  tier: string | null;
  reason: string | null;
  currency: string | null;
  registration: string | null;
  renewal: string | null;
}

/** Pure parser for domain-check, exported for fixture tests. */
export function parseCloudflareCheck(body: Record<string, unknown>, domain: string): CloudflareCheck | null {
  const result = isRecord(body.result) ? body.result : null;
  const domains = result && Array.isArray(result.domains) ? result.domains : [];
  const hit = domains.find((d) => isRecord(d) && typeof d.name === 'string' && d.name.toLowerCase() === domain);
  if (!isRecord(hit)) return null;
  const pricing = isRecord(hit.pricing) ? hit.pricing : {};
  return {
    name: domain,
    registrable: typeof hit.registrable === 'boolean' ? hit.registrable : null,
    tier: str(hit.tier),
    reason: str(hit.reason),
    currency: typeof pricing.currency === 'string' ? pricing.currency.toUpperCase() : null,
    registration: parseAmount(pricing.registration_cost),
    renewal: parseAmount(pricing.renewal_cost),
  };
}

function toCheck(parsed: CloudflareCheck | null): CheckResult {
  if (!parsed) return { status: 'unknown', premium: null, reason: reason('missing_result', 'Cloudflare omitted this name from the result') };
  const premium = parsed.tier === null ? null : parsed.tier === 'premium';
  if (parsed.registrable === true) return { status: 'available', premium, reason: reason('provider_available', 'Cloudflare real-time check: registrable') };
  if (parsed.registrable === null) return { status: 'unknown', premium, reason: reason('provider_unclear', 'Cloudflare did not state registrability') };
  if (parsed.reason && UNSUPPORTED_REASONS.has(parsed.reason)) {
    throw new ProviderError('unsupported', `Cloudflare Registrar API does not register this extension (${parsed.reason})`);
  }
  switch (parsed.reason) {
    case 'domain_unavailable':
      return { status: 'unavailable', premium, reason: reason('domain_unavailable', 'Cloudflare: registered, reserved or otherwise restricted') };
    case 'domain_premium':
      return { status: 'restricted', premium: true, reason: reason('domain_premium', 'Cloudflare: premium pricing applies and the API only registers standard names') };
    case 'extension_disallows_registration':
      return { status: 'restricted', premium, reason: reason('extension_disallows_registration', 'Cloudflare: the registry currently disallows new registrations') };
    default:
      return { status: 'unknown', premium, reason: reason(parsed.reason ?? 'not_registrable', `Cloudflare: not registrable${parsed.reason ? ` (${parsed.reason})` : ''}`) };
  }
}

export interface CloudflareTransfer {
  transferable: boolean | null;
  reasons: string[];
  currency: string | null;
  transfer: string | null;
  renewal: string | null;
}

/** Pure parser for domain-transfer-check (result.domains keyed by name), exported for fixture tests. */
export function parseCloudflareTransfer(body: Record<string, unknown>, domain: string): CloudflareTransfer | null {
  const result = isRecord(body.result) ? body.result : null;
  const domains = result && isRecord(result.domains) ? result.domains : null;
  const hit = domains ? domains[domain] : undefined;
  if (!isRecord(hit)) return null;
  const pricing = isRecord(hit.pricing) ? hit.pricing : {};
  return {
    transferable: typeof hit.transferable === 'boolean' ? hit.transferable : null,
    reasons: Array.isArray(hit.reasons) ? hit.reasons.filter(isRecord).map((r) => str(r.code) ?? '').filter(Boolean) : [],
    currency: typeof pricing.currency === 'string' ? pricing.currency.toUpperCase() : null,
    transfer: parseAmount(pricing.transfer_cost),
    renewal: parseAmount(pricing.renewal_cost),
  };
}

export class CloudflareAdapter implements ProviderAdapter {
  readonly providerId = 'cloudflare';
  readonly testOperation = 'GET /accounts/{account_id}/registrar/extensions';

  async testCredentials(ctx: AdapterContext) {
    const response = await ctx.http.request({ method: 'GET', url: `${accountPath(ctx, 'extensions')}?per_page=1`, headers: headers(ctx) });
    envelope(ctx, response);
    return { operation: this.testOperation, message: 'Cloudflare accepted the token for this account (listing Registrar extensions succeeded).' };
  }

  /** Supported extensions only; Cloudflare publishes no price catalog. */
  async catalog(ctx: AdapterContext): Promise<CatalogResult> {
    const suffixes: string[] = [];
    let cursor = '';
    for (let page = 0; page < 200; page++) {
      const params = new URLSearchParams({ per_page: '50' });
      if (cursor) params.set('cursor', cursor);
      const response = await ctx.http.request({ method: 'GET', url: `${accountPath(ctx, 'extensions')}?${params}`, headers: headers(ctx) });
      const body = envelope(ctx, response);
      if (!Array.isArray(body.result)) throw new ProviderError('bad_response', 'Cloudflare extensions response has no result array');
      const items = body.result;
      for (const item of items) {
        const name = isRecord(item) && isRecord(item.metadata) ? str(item.metadata.name) : null;
        if (name) suffixes.push(name.toLowerCase().replace(/^\./, ''));
      }
      cursor = isRecord(body.result_info) ? (str(body.result_info.cursor) ?? '') : '';
      if (!cursor || items.length === 0) break;
    }
    return { suffixes: [...new Set(suffixes)], entries: [], source: 'Cloudflare Registrar extensions' };
  }

  private async domainCheck(ctx: AdapterContext, domain: DomainParts) {
    const response = await ctx.http.request({
      method: 'POST',
      url: accountPath(ctx, 'domain-check'),
      headers: headers(ctx),
      body: JSON.stringify({ domains: [domain.ascii] }),
    });
    return parseCloudflareCheck(envelope(ctx, response), domain.ascii);
  }

  async check(ctx: AdapterContext, domain: DomainParts) {
    return toCheck(await this.domainCheck(ctx, domain));
  }

  async quote(ctx: AdapterContext, domain: DomainParts) {
    const parsed = await this.domainCheck(ctx, domain);
    const check = toCheck(parsed);
    if (!parsed || check.status !== 'available' || !parsed.currency) return { check, offers: [] };
    return {
      check,
      offers: [
        draft({
          kind: 'exact_quote',
          currency: parsed.currency,
          registration: { amount: parsed.registration, years: 1 },
          renewal: { amount: parsed.renewal, years: 1 },
          premium: { status: parsed.tier === 'standard' ? 'not_premium' : parsed.tier === 'premium' ? 'confirmed' : 'unknown', registration: null, renewal: null },
          source: { label: 'Cloudflare domain-check (real-time)', url: CHECK_DOC },
        }),
      ],
    };
  }

  /** Read-only transfer check without an auth code: Domain Scout never requests authorization codes. */
  async transfer(ctx: AdapterContext, domain: DomainParts) {
    const response = await ctx.http.request({
      method: 'POST',
      url: accountPath(ctx, 'domain-transfer-check'),
      headers: headers(ctx),
      body: JSON.stringify({ domains: [{ domain_name: domain.ascii }] }),
    });
    const parsed = parseCloudflareTransfer(envelope(ctx, response), domain.ascii);
    if (!parsed) return { offers: [], reason: reason('missing_result', 'Cloudflare returned no transfer result for this name') };
    const reasons = parsed.reasons.length ? ` (${parsed.reasons.join(', ')})` : '';
    if (parsed.transferable !== true || !parsed.currency || parsed.transfer === null) {
      return { offers: [], reason: reason('not_transferable', `Cloudflare reported not transferable without an auth code${reasons}`) };
    }
    return {
      offers: [
        draft({
          purchasePath: 'transfer',
          kind: 'exact_quote',
          currency: parsed.currency,
          // transfer_cost is the first-year cost; renewal_cost covers each later year.
          transfer: { amount: parsed.transfer, includesYears: 1 },
          renewal: { amount: parsed.renewal, years: 1 },
          source: { label: 'Cloudflare domain-transfer-check', url: TRANSFER_DOC },
        }),
      ],
      reason: reason('transfer_price', `Cloudflare reported transferable${reasons}`),
    };
  }
}
