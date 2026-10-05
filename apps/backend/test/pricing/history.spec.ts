import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OfferListResponse, PriceHistoryResponse } from '@domain-scout/contracts';
import { CatalogHandler } from '../../src/providers/handlers.js';
import { offerRecord } from '../../src/providers/records.js';
import { draft } from '../../src/providers/adapters/types.js';
import { EvidenceRepository } from '../../src/storage/evidence.js';
import { TransportError } from '../../src/providers/transport.js';
import { createProvidersApp, fixture, jobItem, operationContext, type ProvidersTestApp } from '../providers/helpers.js';

const HOUR = 3_600_000;

describe('price history (H01-H03)', () => {
  let t: ProvidersTestApp;
  const refresh = (body?: string) => {
    t.transport.reset();
    t.transport.on(/pricing\/get/, body ? { status: 200, headers: {}, body } : fixture('porkbun', 'pricing'));
    return t.app.get(CatalogHandler).execute(jobItem('catalog', 'porkbun', 'porkbun'), operationContext(t));
  };

  beforeAll(async () => {
    t = await createProvidersApp({});
    await refresh();
    t.clock.advance(12 * HOUR);
    const changed = JSON.parse(fixture('porkbun', 'pricing').body);
    changed.pricing.com.registration = '10.50';
    await refresh(JSON.stringify(changed));
    // Nothing observed for three days (the failed attempt adds no prices), then a new fetch.
    t.clock.advance(72 * HOUR);
    t.transport.reset();
    t.transport.on(/pricing\/get/, new TransportError('network', 'Network error'));
    await t.app.get(CatalogHandler).execute(jobItem('catalog', 'porkbun', 'porkbun'), operationContext(t));
    t.clock.advance(HOUR);
    await refresh();
  });
  afterAll(() => t.close());

  it('keeps every observation in one comparable series and lists gaps without interpolating', async () => {
    const res = PriceHistoryResponse.parse((await t.api.get('/price-history?suffix=com&providerId=porkbun').expect(200)).body);
    expect(res.data).toHaveLength(1);
    const series = res.data[0]!;
    expect(series).toMatchObject({ providerId: 'porkbun', scope: 'com', purchasePath: 'new_registration', currency: 'USD', termYears: 1, promotional: false });
    expect(series.points.map((p) => [p.observedAt, p.registration])).toEqual([
      ['2026-10-05T12:00:00.000Z', '11.08'],
      ['2026-10-06T00:00:00.000Z', '10.50'],
      ['2026-10-09T01:00:00.000Z', '11.08'],
    ]);
    // Coverage runs until each observation goes stale (24 h); the uncovered period is a gap.
    expect(series.gaps).toEqual([{ from: '2026-10-07T00:00:00.000Z', to: '2026-10-09T01:00:00.000Z' }]);
  });

  it('separates series that are not comparable (scope, path, promotion)', async () => {
    const evidence = t.app.get(EvidenceRepository);
    const now = t.clock.iso();
    const quote = offerRecord({
      providerId: 'porkbun',
      domain: 'xq7mz9brandtest.com',
      suffix: 'com',
      draft: draft({ kind: 'exact_quote', currency: 'USD', registration: { amount: '9.73', years: 1 }, promotional: true, source: { label: 'fixture', url: null } }),
      observedAt: now,
      staleAt: now,
      destination: null,
    });
    evidence.insertOffer(quote.write);
    const res = PriceHistoryResponse.parse((await t.api.get('/price-history?domain=xq7mz9brandtest.com').expect(200)).body);
    const keys = res.data.map((s) => `${s.scope}|${s.promotional}`);
    expect(keys).toContain('com|false');
    expect(keys).toContain('xq7mz9brandtest.com|true');
    const domainSeries = res.data.find((s) => s.scope === 'xq7mz9brandtest.com')!;
    expect(domainSeries.points).toHaveLength(1);
    expect(domainSeries.points[0]!.kind).toBe('exact_quote');
  });

  it('keeps renewal terms covering different years in separate series', async () => {
    const evidence = t.app.get(EvidenceRepository);
    const now = t.clock.iso();
    for (const years of [1, 2]) {
      const record = offerRecord({
        providerId: 'namecom',
        domain: 'xq7mz9renewal.com',
        suffix: 'com',
        draft: draft({
          purchasePath: 'transfer',
          kind: 'exact_quote',
          currency: 'USD',
          transfer: { amount: '10.00', includesYears: 1 },
          renewal: { amount: years === 1 ? '30.00' : '60.00', years },
          source: { label: 'fixture', url: null },
        }),
        observedAt: now,
        staleAt: now,
        destination: null,
      });
      evidence.insertOffer(record.write);
    }
    const res = PriceHistoryResponse.parse((await t.api.get('/price-history?domain=xq7mz9renewal.com&providerId=namecom').expect(200)).body);
    expect(res.data.filter((s) => s.scope === 'xq7mz9renewal.com')).toHaveLength(2);
  });

  it('paginates series and filters by time', async () => {
    const page = PriceHistoryResponse.parse((await t.api.get('/price-history?limit=1').expect(200)).body);
    expect(page.data).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const since = PriceHistoryResponse.parse((await t.api.get('/price-history?suffix=com&since=2026-10-09T00:00:00.000Z').expect(200)).body);
    expect(since.data[0]!.points).toHaveLength(1);
  });

  it('a provider-stated quote expiry makes the quote expired before its normal stale time', async () => {
    const evidence = t.app.get(EvidenceRepository);
    const now = t.clock.now();
    const record = offerRecord({
      providerId: 'cloudflare',
      domain: 'xq7mz9expiry.com',
      suffix: 'com',
      draft: draft({
        kind: 'exact_quote',
        currency: 'USD',
        registration: { amount: '8.57', years: 1 },
        quoteExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
        source: { label: 'fixture', url: null },
      }),
      observedAt: now.toISOString(),
      staleAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      destination: null,
    });
    evidence.insertOffer(record.write);
    t.clock.advance(2 * 60_000);
    const offers = OfferListResponse.parse((await t.api.get('/domains/xq7mz9expiry.com/offers').expect(200)).body).data;
    expect(offers.find((o) => o.providerId === 'cloudflare')).toMatchObject({ freshness: 'expired', observedAt: now.toISOString() });
  });
});
