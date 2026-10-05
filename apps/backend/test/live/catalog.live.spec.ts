import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OfferListResponse, ProviderResponse } from '@domain-scout/contracts';
import { SystemClock } from '../../src/core/clock.js';
import { CatalogHandler } from '../../src/providers/handlers.js';
import { CREDENTIAL_ENV } from '../../src/providers/credentials.js';
import { FetchProviderTransport, ProviderTransport, type ProviderHttpRequest, type ProviderHttpResponse } from '../../src/providers/transport.js';
import { createTestApp, type TestApp } from '../helpers.js';
import { jobItem, operationContext } from '../providers/helpers.js';

/**
 * Authorized live fetch (docs/IMPLEMENTATION.md "Live network rule"): Porkbun's keyless public
 * pricing endpoint only, with no credentials and no candidate names. One request per run.
 * Run with DOMAIN_SCOUT_LIVE_TESTS=1; add DOMAIN_SCOUT_CAPTURE_FIXTURES=1 to refresh the trimmed
 * fixture in test/fixtures/providers/porkbun/pricing-live.json.
 */
const live = process.env.DOMAIN_SCOUT_LIVE_TESTS === '1';
const capture = process.env.DOMAIN_SCOUT_CAPTURE_FIXTURES === '1';
const KEEP = ['com', 'net', 'org', 'io', 'dev', 'si', 'de', 'uk', 'co.uk', 'app', 'ai'];

class RecordingTransport extends ProviderTransport {
  readonly calls: { request: ProviderHttpRequest; response: ProviderHttpResponse }[] = [];
  private readonly inner = new FetchProviderTransport();
  async send(request: ProviderHttpRequest) {
    const allowed = new URL(request.url);
    if (allowed.origin !== 'https://api.porkbun.com' || allowed.pathname !== '/api/json/v3/pricing/get') {
      throw new Error(`Live test refused a request outside the authorized endpoint: ${allowed.origin}${allowed.pathname}`);
    }
    const response = await this.inner.send(request);
    this.calls.push({ request, response });
    return response;
  }
}

describe.skipIf(!live)('live: Porkbun keyless catalog', () => {
  let t: TestApp;
  const transport = new RecordingTransport();
  beforeAll(async () => {
    t = await createTestApp({
      clock: new SystemClock(),
      overrides: [
        { provide: ProviderTransport, useValue: transport },
        { provide: CREDENTIAL_ENV, useValue: {} },
      ],
    });
  });
  afterAll(() => t?.close());

  it('fetches and records the public price list without names or keys', async () => {
    const result = await t.app.get(CatalogHandler).execute(jobItem('catalog', 'porkbun', 'porkbun'), {
      ...operationContext(t),
      now: () => new Date(),
      settings: { ...operationContext(t).settings, retries: { maxAttempts: 1, timeoutMs: 60_000 } },
    });
    expect(result.outcome, JSON.stringify(result.error)).toBe('updated');
    expect(transport.calls).toHaveLength(1);
    const { request, response } = transport.calls[0]!;
    expect(request.body).toBeUndefined();
    expect(Object.keys(request.headers ?? {}).map((h) => h.toLowerCase())).toEqual(['accept']);

    const provider = ProviderResponse.parse((await t.api.get('/providers/porkbun').expect(200)).body).data;
    expect(provider.catalog?.suffixCount).toBeGreaterThan(100);
    const com = OfferListResponse.parse((await t.api.get('/providers/porkbun/catalog?suffix=com').expect(200)).body).data[0]!;
    expect(com).toMatchObject({ kind: 'published', currency: 'USD', freshness: 'fresh' });
    expect(com.registration.amount).toMatch(/^\d+\.\d{2,}$/);
    console.info(`[live] porkbun catalog: ${provider.catalog?.suffixCount} suffixes at ${provider.catalog?.fetchedAt}`);

    if (capture) {
      const body = JSON.parse(response.body) as { status: string; pricing: Record<string, unknown> };
      const trimmed = { status: body.status, pricing: Object.fromEntries(KEEP.filter((k) => k in body.pricing).map((k) => [k, body.pricing[k]])) };
      const file = {
        provenance: `captured live response from https://api.porkbun.com/api/json/v3/pricing/get (keyless, no names), ${new Date().toISOString()}; trimmed to ${Object.keys(trimmed.pricing).length} of ${Object.keys(body.pricing).length} TLDs`,
        request: { method: 'GET', url: 'https://api.porkbun.com/api/json/v3/pricing/get' },
        response: { status: response.status, headers: { 'content-type': response.headers['content-type'] ?? 'application/json' }, json: trimmed },
      };
      writeFileSync(new URL('../fixtures/providers/porkbun/pricing-live.json', import.meta.url), `${JSON.stringify(file, null, 2)}\n`);
    }
  }, 90_000);
});
