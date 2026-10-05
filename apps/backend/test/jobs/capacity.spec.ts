import { afterEach, describe, expect, it } from 'vitest';
import { ResultFilter } from '@domain-scout/contracts';
import { createJobsApp, domains, fakeHandler, registryResult, type JobsTestApp } from './helpers.js';

describe('job capacity', () => {
  let t: JobsTestApp;
  afterEach(() => t?.close());

  // B08: at least 1,000 unique domains after expansion, without manual splitting. Deterministic fake
  // transport; registry spacing is disabled so this measures the engine, not a registry's limits.
  it('runs a 1,000-item job with every item accounted for', async () => {
    t = await createJobsApp({ engine: { batchSize: 32, maxBuffered: 128 } });
    const suffixes = ['com', 'net', 'org', 'io', 'dev', 'si', 'de', 'uk'];
    const handler = fakeHandler({
      operation: 'registry',
      sourceKey: (item) => `registry:${item.suffix}`,
      execute: (item, ctx) => registryResult(item, ctx, item.seq % 7 === 0 ? 'registered' : 'no_record'),
    });
    t.registry.use(handler);
    const list = domains(1000, suffixes);
    const started = performance.now();
    const job = t.jobs.submit({ type: 'registry_scan', input: { domains: list, format: 'auto', extensions: [] }, recheck: false });
    const done = await t.finished(job.id, 60_000);
    const durationMs = Math.round(performance.now() - started);
    console.info(`1,000-item job finished in ${durationMs} ms`);

    expect(done.state).toBe('completed');
    expect(done.counters).toMatchObject({ total: 1000, finished: 1000, pending: 0, running: 0, interrupted: 0, resolved: 1000, unresolved: 0 });
    expect(done.counters.outcomes).toEqual({ registered: 143, no_record: 857 });
    expect(handler.calls).toHaveLength(1000);
    expect(new Set(handler.calls.map((c) => c.item.id)).size).toBe(1000);
    const stored = t.db.get<{ items: number; observed: number }>(
      `SELECT COUNT(*) AS items, COUNT(registry_observation_id) AS observed FROM job_items WHERE job_id = ? AND state = 'finished'`,
      [job.id],
    )!;
    expect(stored).toEqual({ items: 1000, observed: 1000 });
    expect(t.jobEvents(job.id).filter((e) => e.type === 'result.observed')).toHaveLength(1000);
    const ids = t.results.matchingIds(job.id, ResultFilter.parse({}));
    expect(ids).toHaveLength(1000);
    const page = t.results.list(job.id, ResultFilter.parse({ suffixes: ['si'] }), null, 1000);
    expect(page.total).toBe(125);
  });
});
