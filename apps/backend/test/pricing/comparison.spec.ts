import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ComparisonResponse, type FxRate, type Offer } from '@domain-scout/contracts';
import { computeRow, rankRows, type RowOptions } from '../../src/pricing/comparison.js';
import { CatalogHandler, QuoteHandler } from '../../src/providers/handlers.js';
import { EvidenceRepository } from '../../src/storage/evidence.js';
import { createProvidersApp, fixture, jobItem, operationContext, type ProvidersTestApp } from '../providers/helpers.js';

function offer(partial: Partial<Offer> = {}): Offer {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    providerId: 'porkbun',
    domain: 'xq7mz9brandtest.com',
    suffix: 'com',
    purchasePath: 'new_registration',
    kind: 'exact_quote',
    currency: 'USD',
    region: null,
    registration: { amount: '10.00', years: 1 },
    minYears: null,
    renewal: { amount: '20.00', years: 1 },
    transfer: { amount: '15.00', includesYears: 1 },
    fees: { icann: null, other: [], tax: 'unknown' },
    premium: { status: 'not_premium', registration: null, renewal: null },
    promotion: null,
    observedAt: '2026-10-05T12:00:00.000Z',
    publishedAt: null,
    quoteExpiresAt: null,
    staleAt: '2026-10-05T12:15:00.000Z',
    freshness: 'fresh',
    source: { label: 'fixture', url: null },
    destination: null,
    ...partial,
  };
}

const opts = (partial: Partial<RowOptions> = {}): RowOptions => ({
  domain: 'xq7mz9brandtest.com',
  providerId: 'porkbun',
  path: 'new_registration',
  horizonYears: 3,
  currency: null,
  fxRates: [],
  destination: 'https://porkbun.com/checkout/search?q=xq7mz9brandtest.com',
  ...partial,
});

describe('computeRow', () => {
  it('initial commitment plus current renewal for remaining years; tax and fee gaps make a subtotal', () => {
    const row = computeRow(offer(), false, opts());
    expect(row).toMatchObject({ initialCommitment: '10.00', initialYears: 1, horizonTotal: '50.00', prepaidBeyondHorizon: null, complete: true, subtotalOnly: true });
    expect(row.missing.sort()).toEqual(['fees', 'tax']);
    expect(row.notes.join(' ')).toContain('estimated');
  });

  it('adds known ICANN and one-time fees exactly', () => {
    const row = computeRow(offer({ fees: { icann: '0.20', other: [{ label: 'setup', amount: '1.00' }], tax: 'included' } }), false, opts());
    expect(row).toMatchObject({ initialCommitment: '11.20', horizonTotal: '51.60', subtotalOnly: false, complete: true, missing: [] });
  });

  it('published prices with unknown premium status are visible but incomplete', () => {
    const row = computeRow(offer({ kind: 'published', domain: null, premium: { status: 'unknown', registration: null, renewal: null } }), false, opts());
    expect(row.complete).toBe(false);
    expect(row.missing).toContain('premium');
    expect(row.horizonTotal).toBe('50.00');
  });

  it('a minimum term beyond the horizon is shown as prepaid', () => {
    const row = computeRow(offer({ minYears: 3 }), false, opts({ horizonYears: 1 }));
    expect(row).toMatchObject({ initialYears: 3, initialCommitment: '50.00', horizonTotal: '50.00', prepaidBeyondHorizon: { years: 2, amount: '40.00' } });
  });

  it('a multi-year registration amount beyond the horizon has no attributable prepaid amount', () => {
    const row = computeRow(offer({ registration: { amount: '150.00', years: 2 }, minYears: 2 }), false, opts({ horizonYears: 1 }));
    expect(row.prepaidBeyondHorizon).toEqual({ years: 1, amount: null });
    expect(row.horizonTotal).toBe('150.00');
  });

  it('unknown renewal leaves the horizon total unknown, not zero', () => {
    const row = computeRow(offer({ renewal: { amount: null, years: 1 } }), false, opts());
    expect(row).toMatchObject({ horizonTotal: null, complete: false });
    expect(row.missing).toContain('renewal');
  });

  it('converts only with an attributed FX rate', () => {
    const rate: FxRate = { from: 'USD', to: 'EUR', rate: '0.9', source: 'ECB reference rate', observedAt: '2026-10-05T00:00:00.000Z' };
    const converted = computeRow(offer(), false, opts({ currency: 'EUR', fxRates: [rate] }));
    expect(converted).toMatchObject({ currency: 'EUR', nativeCurrency: 'USD', horizonTotal: '45.00', fx: { rate: '0.9', source: 'ECB reference rate' } });
    const missing = computeRow(offer(), false, opts({ currency: 'GBP', fxRates: [rate] }));
    expect(missing).toMatchObject({ currency: 'USD', complete: false });
    expect(missing.missing).toContain('fx_rate');
  });

  it('an applied promotion needs verified eligibility, a covered term and no expiry to be complete', () => {
    const promo = { description: 'New customers only', requiresTermYears: null, restrictions: null, expiresAt: null, eligibilityVerified: false };
    const row = computeRow(offer({ promotion: promo }), true, opts());
    expect(row.missing).toContain('promotion_eligibility');
    expect(row.complete).toBe(false);
    const verified = { ...promo, eligibilityVerified: true };
    expect(computeRow(offer({ promotion: verified }), true, opts()).complete).toBe(true);
    const longTerm = computeRow(offer({ promotion: { ...verified, requiresTermYears: 3 } }), true, opts());
    expect(longTerm.complete).toBe(false);
    expect(longTerm.notes.join(' ')).toContain('3-year term');
    const expired = computeRow(offer({ promotion: { ...verified, expiresAt: '2026-10-01T00:00:00.000Z' } }), true, opts({ now: new Date('2026-10-05T12:00:00.000Z') }));
    expect(expired.missing).toContain('promotion_eligibility');
    const coupon = computeRow(offer({ promotion: { ...promo, description: 'Coupon X (not applied)' } }), false, opts());
    expect(coupon.complete).toBe(true);
    expect(coupon.notes.join(' ')).toContain('Promotion not applied');
  });

  it('transfers need the included years to reach a horizon total', () => {
    const row = computeRow(offer(), false, opts({ path: 'transfer' }));
    expect(row).toMatchObject({ initialCommitment: '15.00', initialYears: 1, horizonTotal: '55.00', complete: true });
    const unknown = computeRow(offer({ transfer: { amount: '15.00', includesYears: null } }), false, opts({ path: 'transfer' }));
    expect(unknown).toMatchObject({ horizonTotal: null, complete: false });
  });

  it('a provider without prices stays visible with every amount unknown', () => {
    const row = computeRow(null, false, opts({ providerId: 'register-si-arnes-si', destination: 'https://www.arnes.si' }));
    expect(row).toMatchObject({ offerId: null, horizonTotal: null, complete: false, rank: null, destination: 'https://www.arnes.si' });
  });
});

describe('rankRows', () => {
  it('ranks complete rows within one currency and basis; ties share a rank', () => {
    const a = computeRow(offer({ registration: { amount: '9.00', years: 1 } }), false, opts({ providerId: 'a' }));
    const b = computeRow(offer({ registration: { amount: '9.00', years: 1 } }), false, opts({ providerId: 'b' }));
    const c = computeRow(offer(), false, opts({ providerId: 'c' }));
    const eur = computeRow(offer({ currency: 'EUR' }), false, opts({ providerId: 'eur' }));
    const incomplete = computeRow(offer({ renewal: { amount: null, years: 1 } }), false, opts({ providerId: 'incomplete' }));
    const expired = computeRow(offer({ registration: { amount: '1.00', years: 1 }, freshness: 'expired' }), false, opts({ providerId: 'expired' }));
    const { cheapest, lowestSubtotal } = rankRows([a, b, c, eur, incomplete, expired]);
    expect([a.rank, b.rank, c.rank, eur.rank, incomplete.rank, expired.rank]).toEqual([1, 1, 3, 1, null, null]);
    // Fees and tax are unknown on every row, so these are base subtotals, never a confirmed cheapest total.
    expect(cheapest).toEqual([]);
    expect(lowestSubtotal).toEqual([
      { domain: 'xq7mz9brandtest.com', currency: 'USD', providerId: 'a', horizonTotal: '49.00' },
      { domain: 'xq7mz9brandtest.com', currency: 'USD', providerId: 'b', horizonTotal: '49.00' },
      { domain: 'xq7mz9brandtest.com', currency: 'EUR', providerId: 'eur', horizonTotal: '50.00' },
    ]);
  });

  it('does not claim a lowest subtotal across different fee bases', () => {
    const withFees = computeRow(offer({ fees: { icann: '0.20', other: [], tax: 'unknown' } }), false, opts({ providerId: 'fees' }));
    const without = computeRow(offer({ registration: { amount: '5.00', years: 1 } }), false, opts({ providerId: 'nofees' }));
    const { cheapest, lowestSubtotal, limits } = rankRows([withFees, without]);
    expect(cheapest).toEqual([]);
    expect(lowestSubtotal).toEqual([]);
    expect(limits[0]).toContain('no single lowest subtotal');
    expect(withFees.rank).toBe(1);
    expect(without.rank).toBe(1);
  });

  it('unknown fees and tax never produce a confirmed cheapest total (audit 6, P04)', () => {
    // A cheaper row with fees and tax both unknown against a dearer row with known fees and tax.
    const subtotal = computeRow(offer({ registration: { amount: '1.00', years: 1 } }), false, opts({ providerId: 'subtotal' }));
    const confirmed = computeRow(offer({ fees: { icann: '0.20', other: [], tax: 'included' } }), false, opts({ providerId: 'confirmed' }));
    expect(subtotal).toMatchObject({ complete: true, subtotalOnly: true });
    expect(subtotal.missing.sort()).toEqual(['fees', 'tax']);
    const { cheapest, lowestSubtotal } = rankRows([subtotal, confirmed]);
    expect(cheapest).toEqual([{ domain: 'xq7mz9brandtest.com', currency: 'USD', providerId: 'confirmed', horizonTotal: '50.60' }]);
    expect(lowestSubtotal).toEqual([{ domain: 'xq7mz9brandtest.com', currency: 'USD', providerId: 'subtotal', horizonTotal: '41.00' }]);
    // Each ranks only within its own basis.
    expect([subtotal.rank, confirmed.rank]).toEqual([1, 1]);
    expect(rankRows([computeRow(offer({ fees: { icann: null, other: [], tax: 'unknown' } }), false, opts())]).cheapest).toEqual([]);
  });
});

describe('POST /comparisons', () => {
  let t: ProvidersTestApp;
  const DOMAIN = 'xq7mz9brandtest.com';
  beforeAll(async () => {
    t = await createProvidersApp({
      DOMAIN_SCOUT_PORKBUN_API_KEY: 'pk1_compare_0001',
      DOMAIN_SCOUT_PORKBUN_SECRET_API_KEY: 'sk1_compare_0001',
      DOMAIN_SCOUT_CLOUDFLARE_ACCOUNT_ID: 'acc0123',
      DOMAIN_SCOUT_CLOUDFLARE_API_TOKEN: 'cf_compare_0001',
    });
    t.transport.on(/pricing\/get/, fixture('porkbun', 'pricing'));
    const ctx = operationContext(t);
    await t.app.get(CatalogHandler).execute(jobItem('catalog', 'porkbun', 'porkbun'), ctx);
    t.transport.reset();
    t.transport.on(/domain-check/, fixture('cloudflare', 'check', { domain: DOMAIN }));
    const quote = await t.app.get(QuoteHandler).execute(jobItem('quote', DOMAIN, 'cloudflare', 'com'), ctx);
    const evidence = t.app.get(EvidenceRepository);
    for (const e of quote.evidence) {
      if (e.kind === 'offer') evidence.insertOffer(e.row);
      else evidence.insertObservation(e.row);
    }
  });
  afterAll(() => t.close());

  it('ranks only complete rows and pairs every price with its own provider link', async () => {
    const res = await t.api.post('/comparisons').send({ domains: [DOMAIN] }).expect(200);
    const comparison = ComparisonResponse.parse(res.body).data;
    const cloudflare = comparison.rows.find((r) => r.providerId === 'cloudflare')!;
    const porkbun = comparison.rows.find((r) => r.providerId === 'porkbun')!;
    expect(cloudflare).toMatchObject({ kind: 'exact_quote', horizonTotal: '25.71', complete: true, rank: 1, destination: 'https://domains.cloudflare.com/' });
    // The Porkbun row carries the Porkbun catalog price and the Porkbun link, never another provider's.
    expect(porkbun).toMatchObject({ kind: 'published', complete: false, rank: null, destination: `https://porkbun.com/checkout/search?q=${DOMAIN}` });
    // Cloudflare does not state tax, so its total is a base subtotal and no confirmed cheapest total exists.
    expect(cloudflare.subtotalOnly).toBe(true);
    expect(comparison.cheapest).toEqual([]);
    expect(comparison.lowestSubtotal).toEqual([{ domain: DOMAIN, currency: 'USD', providerId: 'cloudflare', horizonTotal: '25.71' }]);
    // Providers without any price stay visible.
    expect(comparison.rows.find((r) => r.providerId === 'hostinger')).toMatchObject({ offerId: null, horizonTotal: null });
    for (const row of comparison.rows) {
      if (!row.destination) continue;
      const host = new URL(row.destination).hostname;
      if (row.providerId === 'porkbun') expect(host).toBe('porkbun.com');
      if (row.providerId === 'cloudflare') expect(host).toBe('domains.cloudflare.com');
      if (row.providerId === 'dynadot') expect(host).toBe('www.dynadot.com');
    }
    expect(comparison.limits.join(' ')).toContain('estimates');
  });

  it('expired or stale quotes are labeled and not newly verified (scenario 17)', async () => {
    t.clock.advance(16 * 60_000);
    const stale = ComparisonResponse.parse((await t.api.post('/comparisons').send({ domains: [DOMAIN], providerIds: ['cloudflare'] }).expect(200)).body).data;
    expect(stale.rows[0]).toMatchObject({ freshness: 'stale', observedAt: '2026-10-05T12:00:00.000Z' });
    // The catalog (24 hours) is still fresh while the quote (15 minutes) is stale.
    const offers = (await t.api.get(`/domains/${DOMAIN}/offers`).expect(200)).body.data as Offer[];
    expect(offers.find((o) => o.providerId === 'porkbun')?.freshness).toBe('fresh');
    expect(offers.find((o) => o.providerId === 'cloudflare')?.freshness).toBe('stale');
  });

  it('omitted horizon and currency come from settings; an explicit null currency keeps original currencies', async () => {
    await t.api.patch('/settings').send({ comparison: { horizonYears: 5, currency: 'EUR' } }).expect(200);
    try {
      const configured = ComparisonResponse.parse((await t.api.post('/comparisons').send({ domains: [DOMAIN], providerIds: ['cloudflare'] }).expect(200)).body).data;
      expect(configured).toMatchObject({ horizonYears: 5, currency: 'EUR' });
      expect(configured.rows[0]!.missing).toContain('fx_rate');
      const native = ComparisonResponse.parse(
        (await t.api.post('/comparisons').send({ domains: [DOMAIN], providerIds: ['cloudflare'], horizonYears: 2, currency: null }).expect(200)).body,
      ).data;
      expect(native).toMatchObject({ horizonYears: 2, currency: null });
      expect(native.rows[0]).toMatchObject({ currency: 'USD', fx: null });
      expect(native.rows[0]!.missing).not.toContain('fx_rate');
    } finally {
      await t.api.patch('/settings').send({ comparison: { horizonYears: 3, currency: null } }).expect(200);
    }
  });

  it('rejects malformed domains and unknown providers', async () => {
    await t.api.post('/comparisons').send({ domains: ['not a domain'] }).expect(400);
    await t.api.post('/comparisons').send({ domains: [DOMAIN], providerIds: ['nope'] }).expect(404);
  });
});
