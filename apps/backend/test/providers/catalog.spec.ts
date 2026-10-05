import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JobResponse, OfferListResponse, ProviderResponse, type Offer } from '@domain-scout/contracts';
import { Database } from '../../src/storage/database.js';
import { EventsService } from '../../src/events/events.service.js';
import { CatalogHandler } from '../../src/providers/handlers.js';
import { CatalogService } from '../../src/providers/catalog.service.js';
import { draft } from '../../src/providers/adapters/types.js';
import { OffersService } from '../../src/pricing/offers.service.js';
import { TransportError } from '../../src/providers/transport.js';
import { createProvidersApp, fixture, jobItem, operationContext, type ProvidersTestApp } from './helpers.js';

const HOUR = 3_600_000;

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('Porkbun keyless catalog', () => {
  let t: ProvidersTestApp;
  beforeAll(async () => {
    t = await createProvidersApp({});
  });
  afterAll(() => t.close());
  afterEach(() => t.transport.reset());

  const refresh = () => t.app.get(CatalogHandler).execute(jobItem('catalog', 'porkbun', 'porkbun'), operationContext(t));

  it('needs no credentials and sends no candidate names', async () => {
    t.transport.on(/pricing\/get/, fixture('porkbun', 'pricing'));
    const result = await refresh();
    expect(result).toMatchObject({ outcome: 'updated', resolved: true, evidence: [] });
    expect(t.transport.requests).toHaveLength(1);
    expect(t.transport.requests[0]!.url).toBe('https://api.porkbun.com/api/json/v3/pricing/get');
    const db = t.app.get(Database);
    expect(db.get('SELECT status, suffix_count FROM catalog_fetches WHERE provider_id = ?', ['porkbun'])).toEqual({ status: 'ok', suffix_count: 3 });
    expect(db.all<{ suffix: string }>('SELECT suffix FROM provider_suffixes WHERE provider_id = ? ORDER BY suffix', ['porkbun']).map((r) => r.suffix)).toEqual([
      'co.uk',
      'com',
      'si',
    ]);
    // catalog.updated is recorded with the state change.
    const events = t.app.get(EventsService).read(0, { types: ['catalog.updated'] });
    expect(events.at(-1)?.payload).toEqual({ providerId: 'porkbun', suffixCount: 3, fetchedAt: '2026-10-05T12:00:00.000Z' });
  });

  it('publishes suffix-level offers with catalog freshness and keeps best prices', async () => {
    const res = OfferListResponse.parse((await t.api.get('/providers/porkbun/catalog').expect(200)).body);
    expect(res.data.map((o) => o.suffix)).toEqual(['co.uk', 'com', 'si']);
    const com = res.data.find((o) => o.suffix === 'com')!;
    expect(com).toMatchObject({ kind: 'published', domain: null, currency: 'USD', freshness: 'fresh', staleAt: '2026-10-06T12:00:00.000Z', destination: null });
    const best = t.app.get(Database).all('SELECT suffix, provider_id, amount FROM best_prices ORDER BY suffix');
    expect(best).toEqual([
      { suffix: 'co.uk', provider_id: 'porkbun', amount: '5.98' },
      { suffix: 'com', provider_id: 'porkbun', amount: '11.08' },
      { suffix: 'si', provider_id: 'porkbun', amount: '15.53' },
    ]);
    const provider = ProviderResponse.parse((await t.api.get('/providers/porkbun').expect(200)).body).data;
    expect(provider.catalog).toMatchObject({ suffixCount: 3, fetchedAt: '2026-10-05T12:00:00.000Z', freshness: 'fresh', lastError: null });
    expect(provider.suffixes).toEqual(['co.uk', 'com', 'si']);
  });

  it('an identical refresh is "unchanged" but still recorded as an observation', async () => {
    t.clock.advance(HOUR);
    t.transport.on(/pricing\/get/, fixture('porkbun', 'pricing'));
    expect((await refresh()).outcome).toBe('unchanged');
    expect(t.app.get(Database).get<{ n: number }>("SELECT COUNT(*) AS n FROM offers WHERE provider_id = 'porkbun' AND suffix = 'com'")?.n).toBe(2);
  });

  it('a failed refresh keeps the old values, which age into stale, and records the error (scenario 7, P08)', async () => {
    t.clock.advance(30 * HOUR);
    t.transport.on(/pricing\/get/, new TransportError('timeout', 'Request timed out'));
    const result = await refresh();
    expect(result).toMatchObject({ outcome: 'failed', resolved: false, retryable: true });
    const offers = OfferListResponse.parse((await t.api.get('/providers/porkbun/catalog?suffix=com').expect(200)).body).data;
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ registration: { amount: '11.08' }, freshness: 'stale', observedAt: '2026-10-05T13:00:00.000Z' });
    const provider = ProviderResponse.parse((await t.api.get('/providers/porkbun').expect(200)).body).data;
    expect(provider.catalog).toMatchObject({ fetchedAt: '2026-10-05T13:00:00.000Z', freshness: 'stale' });
    expect(provider.catalog?.lastError?.code).toBe('catalog_transient');
    // Best prices still use the last known values; nothing became zero.
    expect(t.app.get(Database).get<{ amount: string }>("SELECT amount FROM best_prices WHERE suffix = 'com'")?.amount).toBe('11.08');
  });

  it('an empty catalog is a failed refresh that keeps current prices', async () => {
    t.transport.on(/pricing\/get/, { status: 200, headers: {}, body: JSON.stringify({ status: 'SUCCESS', pricing: {} }) });
    const result = await refresh();
    expect(result).toMatchObject({ outcome: 'failed', resolved: false });
    expect(result.error?.code).toBe('catalog_empty');
    const offers = OfferListResponse.parse((await t.api.get('/providers/porkbun/catalog').expect(200)).body).data;
    expect(offers.map((o) => o.suffix)).toEqual(['co.uk', 'com', 'si']);
  });

  it('a catalog that drops a suffix stops publishing it', async () => {
    const trimmed = JSON.parse(fixture('porkbun', 'pricing').body);
    delete trimmed.pricing.si;
    t.transport.on(/pricing\/get/, { status: 200, headers: {}, body: JSON.stringify(trimmed) });
    expect((await refresh()).outcome).toBe('updated');
    const res = OfferListResponse.parse((await t.api.get('/providers/porkbun/catalog').expect(200)).body);
    expect(res.data.map((o: Offer) => o.suffix)).toEqual(['co.uk', 'com']);
    expect(t.app.get(Database).get("SELECT 1 AS x FROM best_prices WHERE suffix = 'si'")).toBeUndefined();
  });

  it('disabling a provider removes it from best prices; enabling restores it', async () => {
    await t.api.patch('/providers/porkbun').send({ enabled: false }).expect(200);
    expect(t.app.get(Database).get<{ n: number }>('SELECT COUNT(*) AS n FROM best_prices')?.n).toBe(0);
    const provider = ProviderResponse.parse((await t.api.patch('/providers/porkbun').send({ enabled: true, preferred: true }).expect(200)).body).data;
    expect(provider).toMatchObject({ enabled: true, preferred: true, readiness: 'credentials_missing' });
    expect(t.app.get(Database).get<{ n: number }>('SELECT COUNT(*) AS n FROM best_prices')?.n).toBe(2);
  });

  it('catalogs that need keys finish as credential_required without a request', async () => {
    const result = await t.app.get(CatalogHandler).execute(jobItem('catalog', 'namecom', 'namecom'), operationContext(t));
    expect(result).toMatchObject({ outcome: 'credential_required', resolved: false });
    const none = await t.app.get(CatalogHandler).execute(jobItem('catalog', 'godaddy', 'godaddy'), operationContext(t));
    expect(none.outcome).toBe('unsupported');
    expect(t.transport.requests).toHaveLength(0);
  });

  it('POST /providers/:id/catalog/refresh submits a catalog_refresh job through the jobs engine', async () => {
    t.transport.on(/pricing\/get/, fixture('porkbun', 'pricing'));
    const job = JobResponse.parse((await t.api.post('/providers/porkbun/catalog/refresh').set('Idempotency-Key', 'catalog-refresh-1').expect(201)).body).data;
    expect(job.type).toBe('catalog_refresh');
    const again = JobResponse.parse((await t.api.post('/providers/porkbun/catalog/refresh').set('Idempotency-Key', 'catalog-refresh-1').expect(201)).body).data;
    expect(again.id).toBe(job.id);
    const done = await waitFor(async () => {
      const current = JobResponse.parse((await t.api.get(`/jobs/${job.id}`).expect(200)).body).data;
      return ['completed', 'completed_with_errors'].includes(current.state) ? current : null;
    });
    expect(done.state).toBe('completed');
    expect(done.destinations).toContain('api.porkbun.com');
    await t.api.post('/providers/godaddy/catalog/refresh').expect(400);
  });
  it('a successful catalog that lists a suffix without a price makes the older price non-current', () => {
    const catalogs = t.app.get(CatalogService);
    t.clock.advance(HOUR);
    catalogs.recordSuccess('porkbun', { suffixes: ['com', 'co.uk'], entries: [], source: 'fixture' }, t.clock.iso());
    expect(t.app.get(OffersService).latestPublished('porkbun', 'com')).toBeNull();
    expect(t.app.get(Database).get<{ n: number }>("SELECT COUNT(*) AS n FROM best_prices WHERE provider_id = 'porkbun'")?.n).toBe(0);
  });

  it('keeps prices in different currencies apart', () => {
    const catalogs = t.app.get(CatalogService);
    t.clock.advance(HOUR);
    const entry = (currency: string, amount: string) => ({
      suffix: 'com',
      ...draft({ kind: 'published', currency, registration: { amount, years: 1 }, source: { label: 'fixture', url: null } }),
    });
    catalogs.recordSuccess('porkbun', { suffixes: ['com'], entries: [entry('USD', '11.08'), entry('EUR', '10.20')], source: 'fixture' }, t.clock.iso());
    const best = t.app.get(Database).all('SELECT currency, amount FROM best_prices WHERE suffix = ? ORDER BY currency', ['com']);
    expect(best).toEqual([
      { currency: 'EUR', amount: '10.20' },
      { currency: 'USD', amount: '11.08' },
    ]);
    expect(t.app.get(OffersService).providerCatalog('porkbun', 'com', null, 10).items.map((o) => o.currency)).toEqual(['EUR', 'USD']);
    expect(t.app.get(OffersService).domainOffers('xq7mz9brandtest.com', 'com').map((o) => o.currency).sort()).toEqual(['EUR', 'USD']);
    expect(t.app.get(OffersService).latestPublished('porkbun', 'com', 'EUR')?.offer.registration.amount).toBe('10.20');
  });

  it('keeps a one-year price next to a multi-year price for best prices', () => {
    const catalogs = t.app.get(CatalogService);
    t.clock.advance(HOUR);
    const entry = (years: number, amount: string) => ({
      suffix: 'com',
      ...draft({ kind: 'published', currency: 'USD', registration: { amount, years }, source: { label: 'fixture', url: null } }),
    });
    catalogs.recordSuccess('porkbun', { suffixes: ['com'], entries: [entry(1, '10.00'), entry(2, '18.00')], source: 'fixture' }, t.clock.iso());
    expect(t.app.get(Database).get('SELECT amount, years FROM best_prices WHERE suffix = ? AND currency = ?', ['com', 'USD'])).toEqual({ amount: '10.00', years: 1 });
    expect(t.app.get(OffersService).latestPublished('porkbun', 'com')?.offer.registration).toEqual({ amount: '10.00', years: 1 });
  });
});
