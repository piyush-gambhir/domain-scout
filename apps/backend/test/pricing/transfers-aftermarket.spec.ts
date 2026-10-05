import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AftermarketListResponse, page, AftermarketSource, TransferOption } from '@domain-scout/contracts';
import { AftermarketHandler, CatalogHandler, TransferHandler } from '../../src/providers/handlers.js';
import { EvidenceRepository } from '../../src/storage/evidence.js';
import { createProvidersApp, fixture, jobItem, operationContext, type ProvidersTestApp } from '../providers/helpers.js';

const TransferOptions = page(TransferOption, 'TransferOptionsTest');
const Sources = page(AftermarketSource, 'AftermarketSourcesTest');

describe('transfer options and aftermarket (F01-F03, scenario 14)', () => {
  let t: ProvidersTestApp;
  const persist = (evidence: { kind: string; row: unknown }[]) => {
    const repo = t.app.get(EvidenceRepository);
    for (const e of evidence) {
      if (e.kind === 'offer') repo.insertOffer(e.row as never);
      else repo.insertObservation(e.row as never);
    }
  };

  beforeAll(async () => {
    t = await createProvidersApp({ DOMAIN_SCOUT_PORKBUN_API_KEY: 'pk1_transfer_0001', DOMAIN_SCOUT_PORKBUN_SECRET_API_KEY: 'sk1_transfer_0001' });
    t.transport.on(/pricing\/get/, fixture('porkbun', 'pricing'));
    await t.app.get(CatalogHandler).execute(jobItem('catalog', 'porkbun', 'porkbun'), operationContext(t));
  });
  afterAll(() => t.close());

  it('without registry evidence, eligibility is listed as unknown', async () => {
    const options = TransferOptions.parse((await t.api.get('/domains/example.com/transfer-options').expect(200)).body).data;
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ providerId: 'porkbun', kind: 'published', transfer: { amount: '11.08', currency: 'USD' }, includesYears: null });
    expect(options[0]!.eligibility.known).toEqual([]);
    expect(options[0]!.eligibility.unknown[0]).toContain('no registry observation');
    expect(options[0]!.eligibility.unknown).toContain('Registration years included with the transfer');
  });

  it('uses sourced registry statuses and prefers an exact transfer quote', async () => {
    t.app.get(EvidenceRepository).insertObservation({
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'registry',
      subject: 'example.com',
      suffix: 'com',
      sourceId: 'verisign',
      destination: 'https://rdap.verisign.com/com/v1/',
      outcome: 'registered',
      observedAt: '2026-10-05T11:58:00.000Z',
      staleAt: '2026-10-05T12:13:00.000Z',
      payload: {
        id: '22222222-2222-4222-8222-222222222222',
        domain: 'example.com',
        outcome: 'registered',
        checkedAt: '2026-10-05T11:58:00.000Z',
        source: { registryId: 'verisign', protocol: 'rdap', destination: 'https://rdap.verisign.com/com/v1/', routing: 'iana_bootstrap' },
        registration: { registrar: 'RESERVED-Internet Assigned Numbers Authority', statuses: ['client delete prohibited', 'client transfer prohibited', 'client update prohibited'], nameservers: [], createdAt: null, updatedAt: null, expiresAt: null, dnssec: true },
      },
    });
    t.transport.reset();
    t.transport.on(/checkDomain/, fixture('porkbun', 'check-unavailable'));
    persist((await t.app.get(TransferHandler).execute(jobItem('transfer', 'example.com', 'porkbun', 'com'), operationContext(t))).evidence);
    const options = TransferOptions.parse((await t.api.get('/domains/example.com/transfer-options').expect(200)).body).data;
    expect(options[0]).toMatchObject({ providerId: 'porkbun', kind: 'exact_quote' });
    expect(options[0]!.eligibility.known).toEqual([
      'The registry shows the domain registered (rdap https://rdap.verisign.com/com/v1/, checked 2026-10-05T11:58:00.000Z)',
      'Registry status client transfer prohibited (rdap https://rdap.verisign.com/com/v1/, checked 2026-10-05T11:58:00.000Z)',
    ]);
    expect(options[0]!.eligibility.unknown).toContain('Authorization code availability from the current registrar');
  });

  it('lists provider sources and link-only marketplaces', async () => {
    const sources = Sources.parse((await t.api.get('/aftermarket/sources').expect(200)).body).data;
    expect(sources.filter((s) => s.supported).map((s) => s.id).sort()).toEqual(['dynadot', 'namecom', 'porkbun']);
    // Supported lookups disclose names to the provider API host, the same host the handler records.
    expect(sources.find((s) => s.id === 'porkbun')?.apiHosts).toEqual(['api.porkbun.com']);
    for (const source of sources.filter((s) => s.supported)) expect(source.apiHosts).toHaveLength(1);
    for (const id of ['sedo', 'afternic', 'dan', 'atom']) {
      const source = sources.find((s) => s.id === id)!;
      expect(source).toMatchObject({ supported: false, requiresCredentials: false, apiHosts: [] });
      expect(source.reason).toBeTruthy();
    }
  });

  it('retains listing evidence separately from confirmations', async () => {
    t.transport.reset();
    t.transport.on(/marketplace\/getAll/, fixture('porkbun', 'marketplace'));
    persist((await t.app.get(AftermarketHandler).execute(jobItem('aftermarket', 'example-listing.com', 'porkbun', 'com'), operationContext(t))).evidence);
    const listings = AftermarketListResponse.parse((await t.api.get('/domains/example-listing.com/listings').expect(200)).body).data;
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ marketplace: 'Porkbun Marketplace', status: 'fixed_price', price: { amount: '1250.00', currency: 'USD' }, freshness: 'fresh' });
    expect(listings[0]!.caveat).toContain('final acquisition cost');
  });
});
