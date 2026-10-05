import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Job, JobItem, JobProgressPayload, Offer, type Job as JobShape } from '@domain-scout/contracts';
import type { JobItemRecord, OperationContext, OperationResult } from '../../src/jobs/operation.js';
import { JobLifecycle } from '../../src/core/ports.js';
import { TEST_SETTINGS, createJobsApp, fakeHandler, registryResult, type JobsTestApp } from './helpers.js';

function quote(item: JobItemRecord, ctx: OperationContext): OperationResult {
  const id = randomUUID();
  const observedAt = ctx.now().toISOString();
  const staleAt = new Date(ctx.now().getTime() + 900_000).toISOString();
  const payload = {
    id,
    providerId: item.target,
    domain: item.subject,
    suffix: item.suffix,
    purchasePath: 'new_registration',
    kind: 'exact_quote',
    currency: 'USD',
    region: null,
    registration: { amount: '10.00', years: 1 },
    minYears: 1,
    renewal: { amount: '12.00', years: 1 },
    transfer: { amount: null, includesYears: null },
    fees: { icann: '0.20', other: [], tax: 'unknown' },
    premium: { status: 'not_premium', registration: null, renewal: null },
    promotion: null,
    observedAt,
    publishedAt: null,
    quoteExpiresAt: null,
    staleAt,
    source: { label: 'Test quote', url: null },
    destination: null,
  };
  return {
    outcome: 'quoted',
    resolved: true,
    evidence: [
      {
        kind: 'offer',
        row: {
          id,
          providerId: item.target,
          domain: item.subject,
          suffix: item.suffix!,
          purchasePath: 'new_registration',
          kind: 'exact_quote',
          currency: 'USD',
          region: null,
          termYears: 1,
          promotional: false,
          registration: '10.00',
          renewal: '12.00',
          transfer: null,
          observedAt,
          staleAt,
          quoteExpiresAt: null,
          catalogFetchId: null,
          payload,
        },
      },
    ],
  };
}

describe('job events', () => {
  let t: JobsTestApp;
  afterEach(() => t?.close());

  it('emits state, result and progress events in order with contract payloads', async () => {
    t = await createJobsApp({ settings: { ...TEST_SETTINGS, concurrency: { ...TEST_SETTINGS.concurrency, global: 1 } } });
    t.registry.use(fakeHandler({ operation: 'registry', execute: (item, ctx) => registryResult(item, ctx) }));
    const finished: JobShape[] = [];
    const seenInListener: string[] = [];
    const lifecycle = t.app.get(JobLifecycle);
    const off = lifecycle.onFinished((job) => {
      finished.push(job);
      // Listeners run after commit, outside any transaction, so the stored state is already terminal.
      seenInListener.push(`${t.jobs.get(job.id).state}:${t.db.inTransaction}`);
    });
    const job = t.jobs.submit({ type: 'registry_scan', input: { domains: ['a.com', 'b.com', 'c.com'], format: 'auto', extensions: [] }, recheck: false });
    await t.finished(job.id);
    off();

    const events = t.jobEvents(job.id);
    const ids = events.map((e) => Number(e.eventId));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const substantive = events.filter((e) => e.type !== 'job.progress');
    expect(substantive.map((e) => e.type)).toEqual(['job.updated', 'job.updated', 'result.observed', 'result.observed', 'result.observed', 'job.updated']);
    expect(substantive.filter((e) => e.type === 'job.updated').map((e) => Job.parse(e.payload).state)).toEqual(['queued', 'running', 'completed']);
    const observed = substantive.filter((e) => e.type === 'result.observed').map((e) => JobItem.parse(e.payload));
    expect(observed.map((i) => [i.subject, i.state, i.outcome])).toEqual([
      ['a.com', 'finished', 'no_record'],
      ['b.com', 'finished', 'no_record'],
      ['c.com', 'finished', 'no_record'],
    ]);
    expect(observed[0]!.evidence.registry?.freshness).toBe('fresh');
    const progress = events.filter((e) => e.type === 'job.progress');
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(JobProgressPayload.parse(progress[0]!.payload).jobId).toBe(job.id);
    expect(events.every((e) => e.jobId === job.id)).toBe(true);

    expect(finished.map((j) => [j.id, j.state])).toEqual([[job.id, 'completed']]);
    expect(seenInListener).toEqual(['completed:false']);
  });

  it('throttles progress events for large jobs', async () => {
    t = await createJobsApp({ engine: { progressIntervalMs: 60_000 } });
    t.registry.use(fakeHandler({ operation: 'registry', execute: (item, ctx) => registryResult(item, ctx) }));
    const job = t.jobs.submit({
      type: 'registry_scan',
      input: { domains: Array.from({ length: 50 }, (_, n) => `n${n}.com`), format: 'auto', extensions: [] },
      recheck: false,
    });
    await t.finished(job.id);
    const events = t.jobEvents(job.id);
    expect(events.filter((e) => e.type === 'job.progress')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'result.observed')).toHaveLength(50);
  });

  it('emits quote.observed for exact quotes and exposes offers on the item', async () => {
    t = await createJobsApp();
    t.registry.use(fakeHandler({ operation: 'quote', execute: quote }));
    const job = t.jobs.submit({ type: 'quote', domains: ['a.com'], providerIds: ['porkbun', 'namecheap'] });
    expect((await t.finished(job.id)).state).toBe('completed');
    const quotes = t.jobEvents(job.id).filter((e) => e.type === 'quote.observed').map((e) => Offer.parse(e.payload));
    expect(quotes.map((q) => [q.providerId, q.kind, q.freshness, q.registration.amount])).toEqual([
      ['porkbun', 'exact_quote', 'fresh', '10.00'],
      ['namecheap', 'exact_quote', 'fresh', '10.00'],
    ]);
    const item = t.results.list(job.id, { sort: 'input', order: 'asc' }).items[0]!;
    expect(item.evidence.offers).toHaveLength(1);
    expect(item.evidence.offers[0]!.id).toBe(quotes[0]!.id);
  });
});
