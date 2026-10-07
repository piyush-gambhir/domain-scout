import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HistoryListResponse } from '@domain-scout/contracts';
import { Database } from '../../src/storage/database.js';
import { createTestApp, type TestApp } from '../helpers.js';
import { seedItem, seedJob } from './seed.js';

describe('history', () => {
  let t: TestApp;
  const scan = randomUUID();
  const checks = randomUUID();
  const interrupted = randomUUID();
  const cancelledDone = randomUUID();

  beforeAll(async () => {
    t = await createTestApp();
    const db = t.app.get(Database);
    db.transaction(() => {
      seedJob(db, {
        id: scan,
        state: 'completed',
        label: 'Brand ideas 100%',
        input: { type: 'registry_scan', input: { text: 'acme', extensions: ['com', 'io'] } },
        createdAt: '2026-10-01T00:00:00.000Z',
        total: 2,
        finished: 2,
        unresolved: 1,
        outcomes: { no_record: 1, inconclusive: 1 },
      });
      seedItem(db, { id: randomUUID(), jobId: scan, seq: 1, subject: 'acme.com', suffix: 'com', state: 'finished' });
      seedJob(db, { id: checks, type: 'provider_check', state: 'completed', input: { domains: ['xn--bcher-kva.si'] }, createdAt: '2026-10-02T00:00:00.000Z' });
      seedItem(db, { id: randomUUID(), jobId: checks, seq: 1, subject: 'xn--bcher-kva.si', unicode: 'bücher.si', suffix: 'si', state: 'finished' });
      seedJob(db, { id: interrupted, state: 'interrupted', createdAt: '2026-10-03T00:00:00.000Z' });
      seedItem(db, { id: randomUUID(), jobId: interrupted, seq: 1, subject: 'later.dev', suffix: 'dev', state: 'interrupted' });
      seedJob(db, { id: cancelledDone, state: 'cancelled', createdAt: '2026-10-04T00:00:00.000Z' });
      seedItem(db, { id: randomUUID(), jobId: cancelledDone, seq: 1, subject: 'done.dev', suffix: 'dev', state: 'finished' });
    });
  });
  afterAll(() => t.close());

  const list = async (query: string) => HistoryListResponse.parse((await t.api.get(`/history${query}`).expect(200)).body);

  it('lists jobs newest first with counts, extensions and resumability', async () => {
    const page = await list('');
    expect(page.total).toBe(4);
    expect(page.data.map((e) => e.jobId)).toEqual([cancelledDone, interrupted, checks, scan]);
    const byId = Object.fromEntries(page.data.map((e) => [e.jobId, e]));
    expect(byId[scan]).toMatchObject({ type: 'registry_scan', label: 'Brand ideas 100%', total: 2, unresolved: 1, extensions: ['com', 'io'], resumable: false });
    // Outcome counts let history summarize a search without loading the job.
    expect(byId[scan]).toMatchObject({ finished: 2, outcomes: { no_record: 1, inconclusive: 1 } });
    expect(byId[checks]).toMatchObject({ finished: 0, outcomes: {} });
    expect(byId[checks]!.extensions).toEqual(['si']);
    expect(byId[interrupted]!.resumable).toBe(true);
    expect(byId[cancelledDone]!.resumable).toBe(false);
  });

  it('matches q against labels and item subjects, literally', async () => {
    expect((await list('?q=brand')).data.map((e) => e.jobId)).toEqual([scan]);
    expect((await list('?q=ACME.COM')).data.map((e) => e.jobId)).toEqual([scan]);
    expect((await list(`?q=${encodeURIComponent('bücher')}`)).data.map((e) => e.jobId)).toEqual([checks]);
    expect((await list('?q=100%25')).data.map((e) => e.jobId)).toEqual([scan]);
    expect((await list('?q=_')).data).toEqual([]);
  });

  it('filters by type and paginates with an opaque cursor', async () => {
    expect((await list('?type=provider_check')).data.map((e) => e.jobId)).toEqual([checks]);
    const first = await list('?limit=3');
    expect(first.data).toHaveLength(3);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await list(`?limit=3&cursor=${first.nextCursor}`);
    expect(second.data.map((e) => e.jobId)).toEqual([scan]);
    expect(second.nextCursor).toBeNull();
  });
});
