import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SuffixPricesResponse } from '@domain-scout/contracts';
import { EvidenceRepository } from '../../src/storage/evidence.js';
import { EvidenceFixtures } from '../evidence/fakes.js';
import { createTestApp, type TestApp } from '../helpers.js';

describe('suffix prices', () => {
  let t: TestApp;
  let fx: EvidenceFixtures;
  beforeAll(async () => {
    t = await createTestApp();
    fx = new EvidenceFixtures(t.app.get(EvidenceRepository));
    const at = t.clock.iso();
    fx.offer({ providerId: 'porkbun', domain: null, suffix: 'com', registration: '11.08', renewal: '11.08', at });
    fx.offer({ providerId: 'dynadot', domain: null, suffix: 'com', registration: '9.99', renewal: '12.99', at });
    fx.offer({ providerId: 'namecheap', domain: null, suffix: 'com', registration: '6.79', renewal: null, at });
  });
  afterAll(() => t.close());

  it('lists every enabled provider per suffix, cheapest first, with a horizon estimate and purchase template', async () => {
    const res = SuffixPricesResponse.parse((await t.api.get('/prices?suffixes=com,.io&horizonYears=3').expect(200)).body);
    const [com, io] = res.data;
    expect(com!.suffix).toBe('com');
    expect(com!.offers.map((o) => [o.providerId, o.registration, o.horizonTotal])).toEqual([
      ['namecheap', '6.79', null], // renewal unknown: no estimate, never zero
      ['dynadot', '9.99', '35.97'],
      ['porkbun', '11.08', '33.24'],
    ]);
    expect(com!.offers[2]!.purchaseUrlTemplate).toContain('{domain}');
    expect(io).toEqual({ suffix: 'io', offers: [] });
  });

  it('leaves disabled providers out and validates the suffix list', async () => {
    await t.api.patch('/providers/namecheap').send({ enabled: false }).expect(200);
    const res = SuffixPricesResponse.parse((await t.api.get('/prices?suffixes=com').expect(200)).body);
    expect(res.data[0]!.offers.map((o) => o.providerId)).toEqual(['dynadot', 'porkbun']);
    await t.api.get('/prices?suffixes=,').expect(400);
  });
});
