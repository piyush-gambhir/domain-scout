import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainEvidenceResponse, RawDiagnosticResponse } from '@domain-scout/contracts';
import { CollectionsModule } from '../../src/collections/collections.module.js';
import { FakeClock } from '../../src/core/clock.js';
import { InputPreviewer, ProviderDirectory } from '../../src/core/ports.js';
import { EvidenceModule } from '../../src/evidence/evidence.module.js';
import { EvidenceRepository } from '../../src/storage/evidence.js';
import { createModuleApp, type ModuleApp } from './harness.js';
import { EvidenceFixtures, FakeDirectory, FakePreviewer } from './fakes.js';

const T0 = '2026-10-05T12:00:00.000Z';

function nameCheck(name: string, service: string, outcome: string) {
  return {
    name,
    service,
    namespace: `${service} name`,
    outcome,
    destination: `${service}.test`,
    httpStatus: outcome === 'exists' ? 200 : 404,
    reason: { code: outcome, message: outcome },
    detail: null,
  };
}

describe('domain evidence aggregation', () => {
  let t: ModuleApp;
  let http: ReturnType<typeof request>;
  let fx: EvidenceFixtures;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createModuleApp({
      modules: [EvidenceModule, CollectionsModule],
      clock: new FakeClock(new Date(T0)),
      providers: [
        { provide: InputPreviewer, useValue: new FakePreviewer() },
        { provide: ProviderDirectory, useValue: new FakeDirectory() },
      ],
    });
    http = request(t.app.getHttpServer());
    fx = new EvidenceFixtures(t.get(EvidenceRepository));

    ids.oldRegistry = fx.registry('example.com', 'registered', '2026-10-01T00:00:00.000Z');
    ids.failed = fx.registry('example.com', 'rate_limited', '2026-10-05T11:00:00.000Z');
    ids.newRegistry = fx.registry('example.com', 'no_record', '2026-10-05T11:55:00.000Z', { raw: '{"errorCode":404}' });
    fx.registry('other.com', 'registered', '2026-10-05T11:55:00.000Z');
    ids.confirmation = fx.confirmation('example.com', 'porkbun', 'available', '2026-10-05T11:56:00.000Z');
    fx.confirmation('example.com', 'porkbun', 'unavailable', '2026-10-04T11:56:00.000Z');
    ids.quote = fx.offer({ providerId: 'porkbun', domain: 'example.com', suffix: 'com', registration: '12.00', at: '2026-10-05T11:57:00.000Z' });
    ids.catalog = fx.offer({ providerId: 'porkbun', domain: null, suffix: 'com', registration: '10.37', at: '2026-10-05T06:00:00.000Z' });
    fx.offer({ providerId: 'porkbun', domain: null, suffix: 'net', registration: '11.00', at: '2026-10-05T06:00:00.000Z' });
    fx.observation('name_check', 'Example', 'exists', '2026-10-05T11:50:00.000Z', nameCheck('Example', 'github', 'exists'));
    fx.observation('name_check', 'example', 'not_found', '2026-10-05T11:51:00.000Z', nameCheck('example', 'npm', 'not_found'));
    fx.observation('name_check', 'examples', 'exists', '2026-10-05T11:51:00.000Z', nameCheck('examples', 'npm', 'exists'));
    fx.observation('diagnostic', 'example.com', 'no_answer', '2026-10-05T11:52:00.000Z', {
      domain: 'example.com',
      check: 'dns',
      outcome: 'no_answer',
      destination: 'cloudflare-dns.com',
      reason: { code: 'nxdomain', message: 'No answer' },
      data: {},
    });
    fx.observation('listing', 'example.com', 'fixed_price', '2026-10-05T11:53:00.000Z', {
      domain: 'example.com',
      marketplace: 'Test market',
      providerId: null,
      status: 'fixed_price',
      price: { amount: '500.00', currency: 'USD' },
      url: null,
      observedAt: '2026-10-05T11:53:00.000Z',
      source: 'test',
      caveat: 'Listing evidence is not proof of seller authority or final cost',
    });
    const collection = (await http.post('/api/v1/collections').send({ name: 'Mine' }).expect(201)).body.data;
    await http.post(`/api/v1/collections/${collection.id}/entries`).send({ domains: ['example.com'], notes: 'keep' }).expect(200);
    ids.collection = collection.id;
  });
  afterAll(() => t.close());

  it('returns every evidence kind separately, with freshness and history', async () => {
    const res = await http.get('/api/v1/domains/EXAMPLE.com/evidence').expect(200);
    const evidence = DomainEvidenceResponse.parse(res.body).data;
    expect(evidence).toMatchObject({ domain: 'example.com', unicode: 'example.com', suffix: 'com' });

    expect(evidence.registry.map((r) => r.id)).toEqual([ids.newRegistry, ids.failed, ids.oldRegistry]);
    expect(evidence.registry.map((r) => r.freshness)).toEqual(['fresh', 'stale', 'stale']);
    expect(evidence.registry[0]!.reused).toBe(false);

    expect(evidence.confirmations).toHaveLength(2);
    expect(evidence.confirmations[0]!.id).toBe(ids.confirmation);
    expect(evidence.offers.map((o) => o.id).sort()).toEqual([ids.quote, ids.catalog].sort());

    expect(evidence.nameChecks.map((n) => n.service).sort()).toEqual(['github', 'npm']);
    expect(evidence.nameChecks.every((n) => n.freshness === 'fresh')).toBe(true);
    expect(evidence.diagnostics).toHaveLength(1);
    expect(evidence.listings[0]).toMatchObject({ marketplace: 'Test market', freshness: expect.any(String) });
    expect(evidence.collections).toEqual([{ id: ids.collection, name: 'Mine', notes: 'keep' }]);
    expect(evidence.providers[0]).toMatchObject({ providerId: 'porkbun', supportsSuffix: 'yes' });

    // A diagnostic with no DNS answer never changes the registry history.
    expect(evidence.registry[0]!.outcome).toBe('no_record');
  });

  it('rejects names that are not registrable domains', async () => {
    await http.get('/api/v1/domains/not..valid/evidence').expect(400);
    await http.get('/api/v1/domains/www.sub.example.com/evidence').expect(400);
  });

  it('serves raw diagnostics only when retained', async () => {
    const raw = RawDiagnosticResponse.parse((await http.get(`/api/v1/observations/${ids.newRegistry}/raw`).expect(200)).body).data;
    expect(raw).toEqual({ observationId: ids.newRegistry, contentType: 'application/json', body: '{"errorCode":404}', truncated: false });
    await http.get(`/api/v1/observations/${ids.oldRegistry}/raw`).expect(404);
  });
});

describe('domain evidence without optional ports', () => {
  it('falls back to syntactic normalization and no providers', async () => {
    const t = await createModuleApp({ modules: [EvidenceModule], clock: new FakeClock(new Date(T0)) });
    try {
      new EvidenceFixtures(t.get(EvidenceRepository)).registry('xn--bcher-kva.de', 'registered', '2026-10-05T11:59:00.000Z');
      const res = await request(t.app.getHttpServer()).get(`/api/v1/domains/${encodeURIComponent('Bücher.de')}/evidence`).expect(200);
      const evidence = DomainEvidenceResponse.parse(res.body).data;
      expect(evidence).toMatchObject({ domain: 'xn--bcher-kva.de', unicode: 'bücher.de', suffix: 'de', providers: [] });
      expect(evidence.registry).toHaveLength(1);
    } finally {
      await t.close();
    }
  });
});
