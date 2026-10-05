import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExportResponse, JobItemListResponse, ResultFilter, SnapshotResponse, type JobItem } from '@domain-scout/contracts';
import type { JobItemRecord, OperationContext, OperationResult } from '../../src/jobs/operation.js';
import { EvidenceRepository } from '../../src/storage/evidence.js';
import { createJobsApp, fakeHandler, registryResult, type JobsTestApp } from './helpers.js';

const HOUR = 3_600_000;

/** A published catalog price (suffix-level offer) plus the best_prices row derived from it. */
function publishedPrice(t: JobsTestApp, suffix: string, currency: string, amount: string, observedAt: string): string {
  const id = randomUUID();
  const staleAt = new Date(Date.parse(observedAt) + 24 * HOUR).toISOString();
  const source = { label: `Porkbun pricing (${currency})`, url: null };
  const payload = {
    id,
    providerId: 'porkbun',
    domain: null,
    suffix,
    purchasePath: 'new_registration',
    kind: 'published',
    currency,
    region: null,
    registration: { amount, years: 1 },
    minYears: null,
    renewal: { amount: null, years: 1 },
    transfer: { amount: null, includesYears: null },
    fees: { icann: null, other: [], tax: 'unknown' },
    premium: { status: 'unknown', registration: null, renewal: null },
    promotion: null,
    observedAt,
    publishedAt: null,
    quoteExpiresAt: null,
    staleAt,
    source,
    destination: null,
  };
  t.app.get(EvidenceRepository).insertOffer({
    id,
    providerId: 'porkbun',
    domain: null,
    suffix,
    purchasePath: 'new_registration',
    kind: 'published',
    currency,
    region: null,
    termYears: 1,
    promotional: false,
    registration: amount,
    renewal: null,
    transfer: null,
    observedAt,
    staleAt,
    quoteExpiresAt: null,
    catalogFetchId: null,
    payload,
  });
  t.db.run(
    `INSERT INTO best_prices (suffix, currency, provider_id, amount, years, kind, observed_at) VALUES (?, ?, 'porkbun', ?, 1, 'published', ?)`,
    [suffix, currency, amount, observedAt],
  );
  return id;
}

const OUTCOMES: Record<string, string> = {
  'ab.com': 'no_record',
  'zzz.io': 'registered',
  'mmmm.dev': 'inconclusive',
  'c.com': 'no_record',
  'nopriced.xyz': 'no_record',
};

function confirmation(item: JobItemRecord, ctx: OperationContext, status: string): OperationResult {
  const id = randomUUID();
  const checkedAt = ctx.now().toISOString();
  const staleAt = new Date(ctx.now().getTime() + 900_000).toISOString();
  return {
    outcome: status,
    resolved: true,
    evidence: [
      {
        kind: 'observation',
        row: {
          id,
          kind: 'confirmation',
          subject: item.subject,
          suffix: item.suffix,
          sourceId: `provider:${item.target}`,
          destination: 'api.porkbun.test',
          outcome: status,
          observedAt: checkedAt,
          staleAt,
          payload: {
            id,
            providerId: item.target,
            domain: item.subject,
            status,
            premium: null,
            checkedAt,
            staleAt,
            destination: 'api.porkbun.test',
            reason: { code: status, message: status },
          },
        },
      },
    ],
  };
}

describe('job results', () => {
  let t: JobsTestApp;
  let jobId: string;
  let checkJobId: string;
  let collectionId: string;
  let priceAt: string;
  const offerIds = new Map<string, string>();
  const subjects = (items: JobItem[]) => items.map((i) => i.subject);
  const get = async (query: string) => JobItemListResponse.parse((await t.api.get(`/jobs/${jobId}/results?${query}`).expect(200)).body);

  beforeAll(async () => {
    t = await createJobsApp();
    t.registry.use(
      fakeHandler({ operation: 'registry', execute: (item, ctx) => registryResult(item, ctx, OUTCOMES[item.subject] ?? 'no_record') }),
      fakeHandler({ operation: 'provider_check', execute: (item, ctx) => confirmation(item, ctx, item.subject === 'ab.com' ? 'available' : 'unavailable') }),
    );
    const job = t.jobs.submit({ type: 'registry_scan', input: { domains: Object.keys(OUTCOMES), format: 'auto', extensions: [] }, recheck: false });
    jobId = job.id;
    await t.finished(jobId);
    const now = t.clock.iso();
    priceAt = now;
    for (const [suffix, currency, amount] of [
      ['com', 'USD', '10.50'],
      ['io', 'USD', '35.00'],
      ['dev', 'USD', '12.00'],
      ['com', 'EUR', '9.00'],
    ] as const) {
      offerIds.set(`${suffix}:${currency}`, publishedPrice(t, suffix, currency, amount, now));
    }
    collectionId = randomUUID();
    t.db.run(`INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, 'Shortlist', ?, ?)`, [collectionId, now, now]);
    t.db.run(`INSERT INTO collection_entries (id, collection_id, domain, unicode, added_at) VALUES (?, ?, 'ab.com', 'ab.com', ?)`, [
      randomUUID(),
      collectionId,
      now,
    ]);
    const checks = t.jobs.submit({ type: 'provider_check', domains: ['ab.com', 'c.com'], providerIds: ['porkbun'] });
    checkJobId = checks.id;
    await t.finished(checkJobId);
  });
  afterAll(() => t?.close());

  it('returns hydrated items in input order with best price, collections and fresh evidence', async () => {
    const page = await get('');
    expect(page.total).toBe(5);
    expect(page.nextCursor).toBeNull();
    expect(subjects(page.data)).toEqual(['ab.com', 'zzz.io', 'mmmm.dev', 'c.com', 'nopriced.xyz']);
    const ab = page.data[0]!;
    expect(ab).toMatchObject({ state: 'finished', outcome: 'no_record', resolved: true, attempts: 1, target: null, error: null });
    expect(ab.evidence.registry).toMatchObject({ domain: 'ab.com', outcome: 'no_record', freshness: 'fresh', reused: false });
    expect(ab.bestPrice).toEqual({
      providerId: 'porkbun',
      amount: '10.50',
      currency: 'USD',
      kind: 'published',
      years: 1,
      offerId: offerIds.get('com:USD'),
      source: 'Porkbun pricing (USD)',
      observedAt: priceAt,
      freshness: 'fresh',
    });
    expect(ab.collectionIds).toEqual([collectionId]);
    expect(page.data[4]!.bestPrice).toBeNull();
    expect(page.data[2]).toMatchObject({ outcome: 'inconclusive', resolved: false });
  });

  it('paginates with opaque cursors and stable totals', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await get(`limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.total).toBe(5);
      seen.push(...subjects(page.data));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['ab.com', 'zzz.io', 'mmmm.dev', 'c.com', 'nopriced.xyz']);

    const pricePages: string[] = [];
    cursor = null;
    do {
      const page = await get(`sort=price&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      pricePages.push(...subjects(page.data));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pricePages).toEqual(['ab.com', 'c.com', 'mmmm.dev', 'zzz.io', 'nopriced.xyz']);

    const first = await get('limit=2');
    await t.api.get(`/jobs/${jobId}/results?sort=domain&cursor=${first.nextCursor}`).expect(400);
    await t.api.get(`/jobs/${jobId}/results?cursor=not-a-cursor`).expect(400);
    await t.api.get(`/jobs/${randomUUID()}/results`).expect(404);
  });

  it('sorts by every key with nulls last in both directions', async () => {
    expect(subjects((await get('sort=domain')).data)).toEqual(['ab.com', 'c.com', 'mmmm.dev', 'nopriced.xyz', 'zzz.io']);
    expect(subjects((await get('sort=domain&order=desc')).data)).toEqual(['zzz.io', 'nopriced.xyz', 'mmmm.dev', 'c.com', 'ab.com']);
    expect(subjects((await get('sort=length')).data)).toEqual(['c.com', 'ab.com', 'zzz.io', 'mmmm.dev', 'nopriced.xyz']);
    expect(subjects((await get('sort=suffix')).data)).toEqual(['ab.com', 'c.com', 'mmmm.dev', 'zzz.io', 'nopriced.xyz']);
    expect(subjects((await get('sort=outcome')).data)).toEqual(['mmmm.dev', 'ab.com', 'c.com', 'nopriced.xyz', 'zzz.io']);
    expect(subjects((await get('sort=price&order=desc')).data)).toEqual(['zzz.io', 'mmmm.dev', 'c.com', 'ab.com', 'nopriced.xyz']);
    expect(subjects((await get('sort=checkedAt')).data)).toEqual(['ab.com', 'zzz.io', 'mmmm.dev', 'c.com', 'nopriced.xyz']);
    expect(subjects((await get('sort=checkedAt&order=desc')).data)).toEqual(['nopriced.xyz', 'c.com', 'mmmm.dev', 'zzz.io', 'ab.com']);
  });

  it('filters by outcome, suffix, state, resolution, text, length, price and collection', async () => {
    const check = async (query: string, expected: string[]) => {
      const page = await get(query);
      expect(subjects(page.data), query).toEqual(expected);
      expect(page.total, query).toBe(expected.length);
    };
    await check('outcomes=no_record', ['ab.com', 'c.com', 'nopriced.xyz']);
    await check('outcomes=registered,inconclusive', ['zzz.io', 'mmmm.dev']);
    await check('suffixes=com,io', ['ab.com', 'zzz.io', 'c.com']);
    await check('states=finished', ['ab.com', 'zzz.io', 'mmmm.dev', 'c.com', 'nopriced.xyz']);
    await check('states=pending', []);
    await check('resolved=false', ['mmmm.dev']);
    await check('resolved=true', ['ab.com', 'zzz.io', 'c.com', 'nopriced.xyz']);
    await check('q=MM', ['mmmm.dev']);
    await check('q=%25', []);
    await check('maxLength=2', ['ab.com', 'c.com']);
    await check('maxPrice=12', ['ab.com', 'mmmm.dev', 'c.com']);
    await check('maxPrice=9.5&priceCurrency=EUR', ['ab.com', 'c.com']);
    // Returned prices use the same currency as the filter.
    expect((await get('priceCurrency=EUR&sort=price')).data.map((i) => i.bestPrice?.amount ?? null)).toEqual(['9.00', '9.00', null, null, null]);
    await check(`collectionId=${collectionId}`, ['ab.com']);
    await check('inCollection=true', ['ab.com']);
    await check('inCollection=false', ['zzz.io', 'mmmm.dev', 'c.com', 'nopriced.xyz']);
    await check('suffixes=com&maxPrice=11&sort=domain&order=desc', ['c.com', 'ab.com']);
  });

  it('filters provider checks by their confirmation evidence', async () => {
    const page = JobItemListResponse.parse((await t.api.get(`/jobs/${checkJobId}/results?confirmations=available`).expect(200)).body);
    expect(subjects(page.data)).toEqual(['ab.com']);
    expect(page.data[0]!.evidence.confirmation).toMatchObject({ providerId: 'porkbun', status: 'available', freshness: 'fresh' });
    expect(page.data[0]!.target).toBe('porkbun');
    const other = JobItemListResponse.parse((await t.api.get(`/jobs/${checkJobId}/results?confirmations=unavailable,restricted`).expect(200)).body);
    expect(subjects(other.data)).toEqual(['c.com']);
  });

  it('filters registry rows by the newest provider confirmation for their domain (S01)', async () => {
    // Registry items carry no confirmation of their own; the provider-check job confirmed ab.com
    // available and c.com unavailable.
    const check = async (query: string, job: string, expected: string[]) => {
      const page = JobItemListResponse.parse((await t.api.get(`/jobs/${job}/results?${query}`).expect(200)).body);
      expect(subjects(page.data), query).toEqual(expected);
      expect(page.total, query).toBe(expected.length);
    };
    await check('confirmations=available', jobId, ['ab.com']);
    await check('confirmations=unavailable', jobId, ['c.com']);
    await check('confirmations=unknown', jobId, []);
    await check('confirmations=available&outcomes=no_record&sort=domain&order=desc', jobId, ['ab.com']);
    // Sorting uses the same evidence rule: available before unavailable, unconfirmed rows last.
    const bySort = async (query: string) =>
      subjects(JobItemListResponse.parse((await t.api.get(`/jobs/${jobId}/results?${query}`).expect(200)).body).data);
    expect((await bySort('sort=confirmation')).slice(0, 2)).toEqual(['ab.com', 'c.com']);
    expect((await bySort('sort=confirmation&order=desc')).slice(0, 2)).toEqual(['c.com', 'ab.com']);
    const paged = JobItemListResponse.parse((await t.api.get(`/jobs/${jobId}/results?sort=confirmation&limit=1`).expect(200)).body);
    const second = JobItemListResponse.parse(
      (await t.api.get(`/jobs/${jobId}/results?sort=confirmation&limit=1&cursor=${paged.nextCursor}`).expect(200)).body,
    );
    expect([...subjects(paged.data), ...subjects(second.data)]).toEqual(['ab.com', 'c.com']);

    // A newer confirmation from another provider supersedes the older one for registry rows, while
    // provider-check items keep matching on the evidence they recorded themselves.
    const id = randomUUID();
    const at = new Date(t.clock.now().getTime() + 60_000).toISOString();
    const staleAt = new Date(Date.parse(at) + 900_000).toISOString();
    t.app.get(EvidenceRepository).insertObservation({
      id,
      kind: 'confirmation',
      subject: 'ab.com',
      suffix: 'com',
      sourceId: 'provider:dynadot',
      destination: 'api.dynadot.test',
      outcome: 'unavailable',
      observedAt: at,
      staleAt,
      payload: { id, providerId: 'dynadot', domain: 'ab.com', status: 'unavailable', premium: null, checkedAt: at, staleAt, destination: 'api.dynadot.test', reason: { code: 'unavailable', message: 'unavailable' } },
    });
    await check('confirmations=available', jobId, []);
    await check('confirmations=unavailable', jobId, ['ab.com', 'c.com']);
    await check('confirmations=available', checkJobId, ['ab.com']);
    // Unresolved and unconfirmed rows stay countable through the other filters.
    await check('resolved=false', jobId, ['mmmm.dev']);
  });

  it('exposes matching ids and items by id for exports', async () => {
    const filter = ResultFilter.parse({ sort: 'domain', outcomes: ['no_record'] });
    const ids = t.results.matchingIds(jobId, filter);
    const items = t.results.byIds([ids[2]!, randomUUID(), ids[0]!]);
    expect(subjects(items)).toEqual(['nopriced.xyz', 'ab.com']);
    expect(subjects(t.results.byIds(ids))).toEqual(['ab.com', 'c.com', 'nopriced.xyz']);
    const listed = t.results.list(jobId, ResultFilter.parse({}), null, 2);
    expect(listed.total).toBe(5);
    expect(listed.items).toHaveLength(2);
  });

  it('filtered exports use the filter price currency, like the results view (audit 9)', async () => {
    const view = await get('maxPrice=9.5&priceCurrency=EUR');
    expect(view.data.map((i) => [i.subject, i.bestPrice?.amount, i.bestPrice?.currency])).toEqual([
      ['ab.com', '9.00', 'EUR'],
      ['c.com', '9.00', 'EUR'],
    ]);
    const scope = { kind: 'filter', jobId, filter: { maxPrice: '9.5', priceCurrency: 'EUR' } };
    const created = ExportResponse.parse((await t.api.post('/exports').send({ format: 'json', scope }).expect(201)).body).data;
    const doc = JSON.parse((await t.api.get(`/exports/${created.id}/download`).expect(200)).text);
    expect(doc.items.map((i: Record<string, string>) => [i.domain, i.registration, i.currency])).toEqual([
      ['ab.com', '9.00', 'EUR'],
      ['c.com', '9.00', 'EUR'],
    ]);
  });

  it('best prices keep their offer, source and age in results, exports and snapshots (audit 10)', async () => {
    t.clock.advance(25 * HOUR);
    try {
      const [ab] = (await get('q=ab.com')).data;
      expect(ab!.bestPrice).toMatchObject({ offerId: offerIds.get('com:USD'), observedAt: priceAt, freshness: 'stale', source: 'Porkbun pricing (USD)' });
      const created = ExportResponse.parse(
        (await t.api.post('/exports').send({ format: 'csv', scope: { kind: 'selection', itemIds: [ab!.id] }, fields: ['domain', 'registration', 'priceObservedAt'] }).expect(201))
          .body,
      ).data;
      const csv = (await t.api.get(`/exports/${created.id}/download`).expect(200)).text;
      expect(csv).toContain(`ab.com,10.50,${priceAt}`);
      const snapshot = SnapshotResponse.parse(
        (await t.api.post('/snapshots').send({ title: 'Prices', scope: { kind: 'selection', itemIds: [ab!.id] } }).expect(201)).body,
      ).data;
      const doc = JSON.parse((await t.api.get(`/snapshots/${snapshot.id}/download?format=json`).expect(200)).text);
      expect(doc.items[0].prices).toEqual([
        expect.objectContaining({ registration: '10.50', observedAt: priceAt, freshnessAtCreation: 'stale', source: 'Porkbun pricing (USD)' }),
      ]);
    } finally {
      t.clock.advance(-25 * HOUR);
    }
  });

  it('marks reused cached registry evidence', async () => {
    const original = (await get('')).data[0]!.evidence.registry!;
    t.registry.use(
      fakeHandler({
        operation: 'registry',
        execute: (_item, ctx) => (ctx.allowCache ? { outcome: 'no_record', resolved: true, evidence: [], reused: { registryObservationId: original.id } } : registryResult(_item, ctx)),
      }),
    );
    const job = t.jobs.submit({ type: 'registry_scan', input: { domains: ['ab.com'], format: 'auto', extensions: [] }, recheck: false });
    await t.finished(job.id);
    const [item] = t.results.list(job.id, ResultFilter.parse({})).items;
    expect(item!.evidence.registry).toMatchObject({ id: original.id, reused: true, checkedAt: original.checkedAt });
  });
});
