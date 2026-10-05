import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PortfolioComparisonResponse, PortfolioImportResponse, PortfolioListResponse } from '@domain-scout/contracts';
import { parseCsv } from '../../src/pricing/portfolio.service.js';
import { CatalogHandler } from '../../src/providers/handlers.js';
import { offerRecord } from '../../src/providers/records.js';
import { draft } from '../../src/providers/adapters/types.js';
import { EvidenceRepository } from '../../src/storage/evidence.js';
import { createProvidersApp, fixture, jobItem, operationContext, type ProvidersTestApp } from '../providers/helpers.js';

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, CRLF and comments', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n# comment\n\nd,e\n')).toEqual([
      { line: 1, cells: ['a', 'b, c', 'say "hi"'] },
      { line: 4, cells: ['d', 'e'] },
    ]);
  });
});

describe('portfolio (F04)', () => {
  let t: ProvidersTestApp;
  beforeAll(async () => {
    t = await createProvidersApp({});
    t.transport.on(/pricing\/get/, fixture('porkbun', 'pricing'));
    await t.app.get(CatalogHandler).execute(jobItem('catalog', 'porkbun', 'porkbun'), operationContext(t));
  });
  afterAll(() => t.close());

  it('imports CSV rows with per-row validation', async () => {
    const text = [
      'domain,registrar,renewalDate,renewalPrice,currency,notes',
      'example.com,Other Registrar,2027-01-15,24.99,usd,"main, site"',
      'not a domain,,,,,',
      'example.co.uk,,2027-02-30,,,',
      'example.si,,,12.00,,',
      'example.net,,,abc,USD,',
      'example.org,,2027-03-01,,,',
    ].join('\n');
    const res = PortfolioImportResponse.parse((await t.api.post('/portfolio/import').send({ text }).expect(200)).body).data;
    expect(res.imported).toBe(2);
    expect(res.rejected.map((r) => [r.row, r.reason])).toEqual([
      [3, 'Not a registrable domain'],
      [4, 'Renewal date must be a valid YYYY-MM-DD date'],
      [5, 'Renewal price needs a three-letter currency code'],
      [6, 'Renewal price must be a plain non-negative decimal amount'],
    ]);
    const list = PortfolioListResponse.parse((await t.api.get('/portfolio').expect(200)).body).data;
    expect(list.find((e) => e.domain === 'example.com')).toMatchObject({
      registrar: 'Other Registrar',
      renewalDate: '2027-01-15',
      renewalPrice: { amount: '24.99', currency: 'USD' },
      notes: 'main, site',
      source: 'user',
    });
  });

  it('updates existing domains from entries and can replace everything', async () => {
    const update = PortfolioImportResponse.parse(
      (await t.api.post('/portfolio/import').send({ entries: [{ domain: 'EXAMPLE.com', renewalPrice: { amount: '19.99', currency: 'USD' } }] }).expect(200)).body,
    ).data;
    expect(update).toMatchObject({ imported: 0, updated: 1, rejected: [] });
    const replaced = PortfolioImportResponse.parse(
      (await t.api.post('/portfolio/import').send({ replace: true, entries: [{ domain: 'example.com', renewalPrice: { amount: '19.99', currency: 'USD' } }, { domain: 'example.co.uk' }] }).expect(200))
        .body,
    ).data;
    expect(replaced).toMatchObject({ imported: 2, updated: 0 });
    expect(PortfolioListResponse.parse((await t.api.get('/portfolio').expect(200)).body).total).toBe(2);
  });

  it('compares with retained prices, keeping user facts, observations and estimates apart', async () => {
    const rows = PortfolioComparisonResponse.parse((await t.api.get('/portfolio/comparison').expect(200)).body).data;
    const com = rows.find((r) => r.entry.domain === 'example.com')!;
    expect(com.entry.source).toBe('user');
    expect(com.alternatives).toEqual([
      {
        providerId: 'porkbun',
        transfer: { amount: '11.08', currency: 'USD' },
        renewal: { amount: '11.08', currency: 'USD' },
        kind: 'published',
        freshness: 'fresh',
        observedAt: '2026-10-05T12:00:00.000Z',
        transferIncludesYears: null,
      },
    ]);
    expect(com.notes).toContain('Renewal date and price are user-supplied, not observed');
    const uk = rows.find((r) => r.entry.domain === 'example.co.uk')!;
    expect(uk.alternatives[0]).toMatchObject({ providerId: 'porkbun', transfer: { amount: '5.98', currency: 'USD' } });
  });

  it('normalizes multi-year renewal prices per year in estimates', async () => {
    await t.api.post('/portfolio/import').send({ entries: [{ domain: 'xq7mz9portfolio.com', renewalPrice: { amount: '50.00', currency: 'USD' } }] }).expect(200);
    const now = t.clock.iso();
    const record = offerRecord({
      providerId: 'namecom',
      domain: 'xq7mz9portfolio.com',
      suffix: 'com',
      draft: draft({
        purchasePath: 'transfer',
        kind: 'exact_quote',
        currency: 'USD',
        transfer: { amount: '10.00', includesYears: 1 },
        renewal: { amount: '60.00', years: 2 },
        source: { label: 'fixture', url: null },
      }),
      observedAt: now,
      staleAt: now,
      destination: null,
    });
    t.app.get(EvidenceRepository).insertOffer(record.write);
    const rows = PortfolioComparisonResponse.parse((await t.api.get('/portfolio/comparison').expect(200)).body).data;
    const row = rows.find((r) => r.entry.domain === 'xq7mz9portfolio.com')!;
    // 10 transfer (1 year) + 2 more years at 30/year = 70, versus 150 at the user's price.
    expect(row.notes.find((n) => n.startsWith('Estimate: Name.com'))).toContain('70.00 USD versus 150.00');
  });

  it('rejects text after a closing quote', async () => {
    const res = await t.api.post('/portfolio/import').send({ text: 'domain\n"example.co"m\n' }).expect(400);
    expect(res.body.error.message).toContain('after a closing quote');
  });

  it('rejects a file with an unterminated quoted field without importing anything', async () => {
    const before = PortfolioListResponse.parse((await t.api.get('/portfolio').expect(200)).body).total;
    const text = 'domain,notes\nexample.io,"unterminated\nexample.dev,x\n';
    const res = await t.api.post('/portfolio/import').send({ text, replace: true }).expect(400);
    expect(res.body.error.message).toContain('Unterminated quoted field');
    expect(PortfolioListResponse.parse((await t.api.get('/portfolio').expect(200)).body).total).toBe(before);
  });

  it('deletes entries and 404s unknown ids', async () => {
    const list = PortfolioListResponse.parse((await t.api.get('/portfolio').expect(200)).body).data;
    await t.api.delete(`/portfolio/${list[0]!.id}`).expect(200);
    await t.api.delete(`/portfolio/${list[0]!.id}`).expect(404);
  });
});
