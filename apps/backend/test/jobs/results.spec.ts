import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobItemListResponse, ResultFilter, type JobItem } from '@domain-scout/contracts';
import type { JobItemRecord, OperationContext, OperationResult } from '../../src/jobs/operation.js';
import { createJobsApp, fakeHandler, registryResult, type JobsTestApp } from './helpers.js';

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
    const now = new Date().toISOString();
    for (const [suffix, currency, amount] of [
      ['com', 'USD', '10.50'],
      ['io', 'USD', '35.00'],
      ['dev', 'USD', '12.00'],
      ['com', 'EUR', '9.00'],
    ] as const) {
      t.db.run(
        `INSERT INTO best_prices (suffix, currency, provider_id, amount, years, kind, observed_at) VALUES (?, ?, 'porkbun', ?, 1, 'published', ?)`,
        [suffix, currency, amount, now],
      );
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
    expect(ab.bestPrice).toEqual({ providerId: 'porkbun', amount: '10.50', currency: 'USD', kind: 'published', years: 1 });
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
