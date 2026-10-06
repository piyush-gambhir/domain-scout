import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ComparisonResponse } from '@domain-scout/contracts';
import { Database } from '../../src/storage/database.js';
import { EvidenceRepository } from '../../src/storage/evidence.js';
import { EvidenceFixtures } from '../evidence/fakes.js';
import { createTestApp, type TestApp } from '../helpers.js';

/** R08: preferences change presentation only; they never beat a cheaper comparable price. */
describe('preferred providers', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    const fx = new EvidenceFixtures(t.app.get(EvidenceRepository));
    const at = t.clock.iso();
    fx.offer({ providerId: 'porkbun', domain: null, suffix: 'com', registration: '10.00', renewal: '10.00', at });
    fx.offer({ providerId: 'dynadot', domain: null, suffix: 'com', registration: '10.00', renewal: '10.00', at });
    fx.offer({ providerId: 'namecheap', domain: null, suffix: 'com', registration: '9.00', renewal: '9.00', at });
    await t.api.patch('/providers/dynadot').send({ preferred: true }).expect(200);
  });
  afterAll(() => t.close());

  it('orders a preferred provider first only among equal prices', async () => {
    const body = { domains: ['example.com'], providerIds: ['porkbun', 'dynadot', 'namecheap'], horizonYears: 3 };
    const comparison = ComparisonResponse.parse((await t.api.post('/comparisons').send(body).expect(200)).body).data;
    // Published prices are not ranked (premium status unknown) but still list cheapest first.
    expect(comparison.rows.map((r) => [r.providerId, r.horizonTotal])).toEqual([
      ['namecheap', '27.00'],
      ['dynadot', '30.00'],
      ['porkbun', '30.00'],
    ]);
    expect(comparison.cheapest).toEqual([]);
  });

  it('breaks best-price ties toward the preferred provider without overriding a cheaper one', async () => {
    const best = () =>
      t.app.get(Database).get<{ provider_id: string; amount: string }>("SELECT provider_id, amount FROM best_prices WHERE suffix = 'com' AND currency = 'USD'");
    expect(best()).toEqual({ provider_id: 'namecheap', amount: '9.00' });
    await t.api.patch('/providers/namecheap').send({ enabled: false }).expect(200);
    expect(best()).toEqual({ provider_id: 'dynadot', amount: '10.00' });
  });
});
