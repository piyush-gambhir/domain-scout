import { afterEach, describe, expect, it } from 'vitest';
import type { JobItem } from '@domain-scout/contracts';
import type { JobItemRecord, OperationContext, OperationResult } from '../../src/jobs/operation.js';
import { backoffDelay } from '../../src/jobs/scheduler.js';
import { JobStore, type RunSnapshot } from '../../src/jobs/job-store.js';
import { JobScheduler } from '../../src/jobs/scheduler.js';
import { TEST_SETTINGS, createJobsApp, domains, fakeHandler, gate, registryResult, waitFor, type JobsTestApp } from './helpers.js';

function scan(t: JobsTestApp, list: string[], recheck = false) {
  return t.jobs.submit({ type: 'registry_scan', input: { domains: list, format: 'auto', extensions: [] }, recheck });
}

function itemRows(t: JobsTestApp, jobId: string) {
  return t.db.all<{ subject: string; state: string; attempts: number; outcome: string | null; resolved: number; error_json: string | null; retry_at: string | null; registry_observation_id: string | null; finished_at: string | null }>(
    'SELECT * FROM job_items WHERE job_id = ? ORDER BY seq',
    [jobId],
  );
}

const rateLimited = (item: JobItemRecord, ctx: OperationContext, cooldownMs: number, retryable = true): OperationResult =>
  registryResult(item, ctx, 'rate_limited', {
    retryable,
    cooldownUntil: new Date(ctx.now().getTime() + cooldownMs).toISOString(),
    error: { code: 'rate_limited', message: 'Retry-After', retryable: true },
  });

describe('job scheduler', () => {
  let t: JobsTestApp;
  afterEach(() => t?.close());

  it('keeps counters and ends completed or completed_with_errors', async () => {
    t = await createJobsApp();
    t.registry.use(
      fakeHandler({
        operation: 'registry',
        execute: (item, ctx) => registryResult(item, ctx, item.subject.startsWith('taken') ? 'registered' : item.subject.startsWith('odd') ? 'inconclusive' : 'no_record'),
      }),
    );
    const ok = scan(t, ['free.com', 'taken.com']);
    const done = await t.finished(ok.id);
    expect(done.state).toBe('completed');
    expect(done.counters).toEqual({
      total: 2,
      pending: 0,
      running: 0,
      finished: 2,
      interrupted: 0,
      resolved: 2,
      unresolved: 0,
      outcomes: { no_record: 1, registered: 1 },
    });
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();

    const mixed = await t.finished(scan(t, ['free.net', 'odd.net']).id);
    expect(mixed.state).toBe('completed_with_errors');
    expect(mixed.counters).toMatchObject({ resolved: 1, unresolved: 1, outcomes: { no_record: 1, inconclusive: 1 } });
  });

  it('treats outcomes outside RESOLVED_ITEM_OUTCOMES as unresolved even when a handler says resolved', async () => {
    t = await createJobsApp();
    t.registry.use(fakeHandler({ operation: 'registry', execute: (item, ctx) => ({ ...registryResult(item, ctx, 'unsupported'), resolved: true }) }));
    t.registry.use(fakeHandler({ operation: 'quote', execute: () => ({ outcome: 'credential_required', resolved: true, evidence: [] }) }));
    const a = await t.finished(scan(t, ['x.zz']).id);
    expect(a.state).toBe('completed_with_errors');
    expect(a.counters).toMatchObject({ resolved: 0, unresolved: 1, outcomes: { unsupported: 1 } });
    const b = await t.finished(t.jobs.submit({ type: 'quote', domains: ['x.com'], providerIds: ['porkbun'] }).id);
    expect(b.counters).toMatchObject({ resolved: 0, unresolved: 1, outcomes: { credential_required: 1 } });
    expect(t.registry.get('quote') && (t.registry.get('quote') as ReturnType<typeof fakeHandler>).calls).toHaveLength(1);
  });

  it('spaces request starts per source and shares the budget across jobs', async () => {
    t = await createJobsApp({ settings: { ...TEST_SETTINGS, concurrency: { ...TEST_SETTINGS.concurrency, minSourceIntervalMs: 80 } } });
    let inFlight = 0;
    let maxInFlight = 0;
    const handler = fakeHandler({
      operation: 'registry',
      sourceKey: (item) => (item.suffix === 'com' ? 'registry:shared' : 'registry:other'),
      execute: async (item, ctx) => {
        if (item.suffix === 'com') {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 10));
          inFlight -= 1;
        }
        return registryResult(item, ctx);
      },
    });
    t.registry.use(handler);
    const a = scan(t, ['a1.com', 'a2.com', 'a3.com']);
    const b = scan(t, ['b1.com', 'b2.com', 'b3.com', 'b1.org']);
    await Promise.all([t.finished(a.id), t.finished(b.id)]);
    // Dispatch times as the scheduler recorded them (handler bodies start a few microtasks later).
    const shared = t.db
      .all<{ started_at: string }>(`SELECT started_at FROM job_items WHERE suffix = 'com' ORDER BY started_at`)
      .map((r) => Date.parse(r.started_at));
    expect(shared).toHaveLength(6);
    for (let i = 1; i < shared.length; i++) expect(shared[i]! - shared[i - 1]!).toBeGreaterThanOrEqual(80);
    // Spacing also holds between actual request starts, which trail dispatch.
    const starts = handler.calls.filter((c) => c.item.suffix === 'com').map((c) => c.at);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(79);
    expect(maxInFlight).toBe(1);
    // Fair turns between jobs on the shared source.
    expect(handler.calls.filter((c) => c.item.suffix === 'com').map((c) => c.item.subject[0])).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
    // Another source is not held back by the shared one.
    const other = Date.parse(t.db.get<{ started_at: string }>(`SELECT started_at FROM job_items WHERE suffix = 'org'`)!.started_at);
    expect(other).toBeLessThan(shared[1]!);
  });

  it('honors a Retry-After cooldown for every job on the same source and persists it', async () => {
    t = await createJobsApp();
    let limited = false;
    const handler = fakeHandler({
      operation: 'registry',
      sourceKey: () => 'registry:shared',
      execute: (item, ctx) => {
        if (item.subject === 'first.com' && !limited) {
          limited = true;
          return rateLimited(item, ctx, 300);
        }
        return registryResult(item, ctx);
      },
    });
    t.registry.use(handler);
    const a = scan(t, ['first.com', 'second.com']);
    const b = scan(t, ['third.com']);
    const [doneA, doneB] = await Promise.all([t.finished(a.id), t.finished(b.id)]);
    expect(doneA.state).toBe('completed');
    expect(doneB.state).toBe('completed');
    const cooldownCall = handler.calls[0]!;
    expect(cooldownCall.item.subject).toBe('first.com');
    for (const call of handler.calls.slice(1)) expect(call.at - cooldownCall.at).toBeGreaterThanOrEqual(295);
    const retried = itemRows(t, a.id).find((r) => r.subject === 'first.com')!;
    expect(retried.attempts).toBe(2);
    expect(retried.outcome).toBe('no_record');
    const row = t.db.get<{ until: string; reason: string }>('SELECT until, reason FROM source_cooldowns WHERE source_key = ?', ['registry:shared']);
    expect(row?.reason).toBe('rate_limited');
    const cooldownEvents = t.events.read(0, { types: ['source.cooldown'] });
    expect(cooldownEvents).toHaveLength(1);
    expect(cooldownEvents[0]!.payload).toMatchObject({ sourceId: 'registry:shared', until: row!.until });
  });

  it('finishes items unresolved with retryAt when a cooldown exceeds maxCooldownWaitSeconds', async () => {
    t = await createJobsApp({ settings: { ...TEST_SETTINGS, concurrency: { ...TEST_SETTINGS.concurrency, maxCooldownWaitSeconds: 1 } } });
    const handler = fakeHandler({
      operation: 'registry',
      sourceKey: (item) => (item.suffix === 'com' ? 'registry:verisign' : 'registry:other'),
      execute: (item, ctx) => (item.subject === 'a.com' ? rateLimited(item, ctx, 3_600_000) : registryResult(item, ctx)),
    });
    t.registry.use(handler);
    const job = scan(t, ['a.com', 'b.com', 'c.com', 'd.org']);
    const done = await t.finished(job.id);
    expect(done.state).toBe('completed_with_errors');
    expect(handler.calls.map((c) => c.item.subject).sort()).toEqual(['a.com', 'd.org']);
    const rows = itemRows(t, job.id);
    const until = t.db.get<{ until: string }>('SELECT until FROM source_cooldowns WHERE source_key = ?', ['registry:verisign'])!.until;
    for (const subject of ['a.com', 'b.com', 'c.com']) {
      const row = rows.find((r) => r.subject === subject)!;
      expect(row).toMatchObject({ state: 'finished', outcome: 'rate_limited', resolved: 0, retry_at: until });
    }
    expect(rows.find((r) => r.subject === 'a.com')!.attempts).toBe(1);
    expect(JSON.parse(rows.find((r) => r.subject === 'b.com')!.error_json!).code).toBe('source_cooldown');
    expect(done.nextRetryAt).toBe(until);
    expect(done.counters).toMatchObject({ resolved: 1, unresolved: 3, outcomes: { rate_limited: 3, no_record: 1 } });
    const observed = t.jobEvents(job.id).filter((e) => e.type === 'result.observed').map((e) => (e.payload as JobItem).subject);
    expect(observed.sort()).toEqual(['a.com', 'b.com', 'c.com', 'd.org']);

    // A later job does not contact the cooling source either.
    const later = await t.finished(scan(t, ['e.com']).id);
    expect(later.counters.outcomes).toEqual({ rate_limited: 1 });
    expect(handler.calls).toHaveLength(2);
  });

  it('retries transient failures with exponential backoff and jitter, then succeeds', async () => {
    t = await createJobsApp({ engine: { backoffBaseMs: 40 } });
    const handler = fakeHandler({
      operation: 'registry',
      execute: (item, ctx) =>
        ctx.attempt < 3
          ? registryResult(item, ctx, 'inconclusive', { retryable: true, error: { code: 'network', message: 'reset', retryable: true } })
          : registryResult(item, ctx),
    });
    t.registry.use(handler);
    const job = scan(t, ['flaky.com']);
    const done = await t.finished(job.id);
    expect(done.state).toBe('completed');
    expect(handler.calls.map((c) => c.attempt)).toEqual([1, 2, 3]);
    const [first, second, third] = handler.calls.map((c) => c.at);
    expect(second! - first!).toBeGreaterThanOrEqual(19); // 40 ms base, equal jitter: 20..40
    expect(third! - second!).toBeGreaterThanOrEqual(39); // doubled: 40..80
    const row = itemRows(t, job.id)[0]!;
    expect(row).toMatchObject({ attempts: 3, outcome: 'no_record', resolved: 1, error_json: null });
    // Evidence from retried attempts is not kept; only the final observation is.
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM observations WHERE subject = 'flaky.com'")!.n).toBe(1);
  });

  it('computes exponential backoff with equal jitter and a cap', () => {
    const options = { backoffBaseMs: 1000, backoffMaxMs: 30_000 };
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, options, () => 0))).toEqual([500, 1000, 2000, 4000]);
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, options, () => 1))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffDelay(10, options, () => 0.5)).toBe(22_500);
  });

  it('does not retry non-retryable failures and retries thrown errors as internal', async () => {
    t = await createJobsApp();
    const handler = fakeHandler({
      operation: 'registry',
      execute: (item, ctx) => {
        if (item.subject === 'boom.com') throw new Error('socket hang up https://secret.example/?key=abc');
        return registryResult(item, ctx, 'blocked', { retryable: false, error: { code: 'blocked', message: 'blocked', retryable: false } });
      },
    });
    t.registry.use(handler);
    const job = scan(t, ['blocked.com', 'boom.com']);
    const done = await t.finished(job.id);
    expect(done.state).toBe('completed_with_errors');
    expect(handler.calls.filter((c) => c.item.subject === 'blocked.com')).toHaveLength(1);
    expect(handler.calls.filter((c) => c.item.subject === 'boom.com')).toHaveLength(3);
    const boom = itemRows(t, job.id).find((r) => r.subject === 'boom.com')!;
    expect(boom).toMatchObject({ outcome: 'error', resolved: 0, attempts: 3 });
    const error = JSON.parse(boom.error_json!);
    expect(error).toMatchObject({ code: 'internal', retryable: true });
    expect(error.message).not.toContain('secret');
  });

  it('aborts a call at the per-call timeout', async () => {
    t = await createJobsApp({ settings: { ...TEST_SETTINGS, retries: { maxAttempts: 1, timeoutMs: 1000 } } });
    let aborted = false;
    t.registry.use(
      fakeHandler({
        operation: 'registry',
        execute: (_item, ctx) =>
          new Promise<OperationResult>(() => {
            ctx.signal.addEventListener('abort', () => {
              aborted = true;
            });
          }),
      }),
    );
    const job = scan(t, ['slow.com']);
    const done = await t.finished(job.id, 5000);
    expect(aborted).toBe(true);
    const row = itemRows(t, job.id)[0]!;
    expect(row).toMatchObject({ state: 'finished', outcome: 'timeout', resolved: 0 });
    expect(JSON.parse(row.error_json!)).toMatchObject({ code: 'timeout', retryable: true });
    expect(done.state).toBe('completed_with_errors');
  });

  it('cancels mid-run keeping completed evidence, then resumes only unfinished work', async () => {
    t = await createJobsApp({ settings: { ...TEST_SETTINGS, concurrency: { ...TEST_SETTINGS.concurrency, global: 1 } } });
    const hold = gate();
    const handler = fakeHandler({
      operation: 'registry',
      execute: async (item, ctx) => {
        if (item.subject === 'c.com' && ctx.attempt === 1 && handler.calls.filter((c) => c.item.subject === 'c.com').length === 1) {
          await Promise.race([hold.promise, new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))))]);
        }
        return registryResult(item, ctx);
      },
    });
    t.registry.use(handler);
    const job = scan(t, ['a.com', 'b.com', 'c.com', 'd.com', 'e.com']);
    await waitFor(() => handler.calls.some((c) => c.item.subject === 'c.com'), 5000, 'c.com in flight');
    const cancelled = (await t.api.post(`/jobs/${job.id}/cancel`).expect(200)).body.data;
    expect(['cancelling', 'cancelled']).toContain(cancelled.state);
    const after = await t.finished(job.id);
    expect(after.state).toBe('cancelled');
    expect(after.counters).toMatchObject({ finished: 2, interrupted: 1, pending: 2, running: 0 });
    const rows = itemRows(t, job.id);
    expect(rows.map((r) => r.state)).toEqual(['finished', 'finished', 'interrupted', 'pending', 'pending']);
    expect(rows.find((r) => r.subject === 'c.com')!.attempts).toBe(0);
    const kept = rows.filter((r) => r.state === 'finished').map((r) => ({ id: r.registry_observation_id, at: r.finished_at }));
    expect(kept.every((k) => k.id !== null)).toBe(true);

    // Completed evidence is readable while cancelled.
    const results = (await t.api.get(`/jobs/${job.id}/results?states=finished`).expect(200)).body;
    expect(results.data.map((i: JobItem) => i.evidence.registry?.outcome)).toEqual(['no_record', 'no_record']);

    await t.api.post(`/jobs/${job.id}/cancel`).expect(200);
    const resumed = (await t.api.post(`/jobs/${job.id}/resume`).expect(200)).body.data;
    expect(resumed.state).toBe('queued');
    expect(resumed.counters).toMatchObject({ pending: 3, finished: 2, interrupted: 0 });
    const done = await t.finished(job.id);
    expect(done.state).toBe('completed');
    expect(done.finishedAt).not.toBeNull();
    const counts = new Map<string, number>();
    for (const c of handler.calls) counts.set(c.item.subject, (counts.get(c.item.subject) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ 'a.com': 1, 'b.com': 1, 'c.com': 2, 'd.com': 1, 'e.com': 1 });
    const final = itemRows(t, job.id).filter((r) => r.subject === 'a.com' || r.subject === 'b.com');
    expect(final.map((r) => ({ id: r.registry_observation_id, at: r.finished_at }))).toEqual(kept);
    await t.api.post(`/jobs/${job.id}/resume`).expect(409);
    await t.api.post(`/jobs/${job.id}/cancel`).expect(409);
  });

  it('recovers from failed writes without losing items or calling handlers twice', async () => {
    t = await createJobsApp();
    const store = t.app.get(JobStore);
    const save = store.saveRun.bind(store);
    const failed: string[] = [];
    const failOnce = (name: string, when: (snap: RunSnapshot) => boolean) => (snap: RunSnapshot) => {
      if (!failed.includes(name) && when(snap)) {
        failed.push(name);
        throw new Error(`injected ${name} failure`);
      }
    };
    const checks = [
      failOnce('dispatch', (snap) => snap.counters.running === 1 && snap.counters.finished === 0),
      failOnce('finish', (snap) => snap.counters.finished === 1),
      failOnce('terminal', (snap) => snap.state === 'completed'),
    ];
    store.saveRun = (jobId, snap, now) => {
      for (const check of checks) check(snap);
      save(jobId, snap, now);
    };
    const handler = fakeHandler({ operation: 'registry' });
    t.registry.use(handler);
    const job = scan(t, ['a.com', 'b.com', 'c.com']);
    const done = await t.finished(job.id, 15_000);
    expect(failed).toEqual(['dispatch', 'finish', 'terminal']);
    expect(done.state).toBe('completed');
    expect(done.counters).toMatchObject({ total: 3, finished: 3, running: 0, pending: 0, resolved: 3 });
    expect(handler.calls.map((c) => c.item.subject).sort()).toEqual(['a.com', 'b.com', 'c.com']);
    expect(t.jobEvents(job.id).filter((e) => e.type === 'result.observed')).toHaveLength(3);
  });

  it('keeps returned results through a write outage and records them once writes recover', async () => {
    t = await createJobsApp({ settings: { ...TEST_SETTINGS, concurrency: { ...TEST_SETTINGS.concurrency, global: 1 } } });
    const store = t.app.get(JobStore);
    const save = store.saveRun.bind(store);
    let outage = true;
    let refused = 0;
    store.saveRun = (jobId, snap, now) => {
      // Completion writes fail (including the immediate retry and the error fallback); dispatch writes work.
      if (outage && snap.counters.finished >= 1) {
        refused += 1;
        throw new Error('injected write outage');
      }
      save(jobId, snap, now);
    };
    const handler = fakeHandler({ operation: 'registry' });
    t.registry.use(handler);
    const job = scan(t, ['a.com', 'b.com']);
    await waitFor(() => handler.calls.length === 2, 5000, 'both calls');
    await new Promise((r) => setTimeout(r, 50));
    expect(refused).toBeGreaterThanOrEqual(6);
    expect(t.jobs.get(job.id).state).toBe('running');
    outage = false;
    const done = await t.finished(job.id, 5000);
    expect(done.state).toBe('completed');
    expect(done.counters).toMatchObject({ finished: 2, resolved: 2, outcomes: { no_record: 2 } });
    expect(handler.calls).toHaveLength(2);
  });

  it('honors a cooldown whose write failed until the write succeeds', async () => {
    t = await createJobsApp();
    const store = t.app.get(JobStore);
    const save = store.saveRun.bind(store);
    let outage = false;
    store.saveRun = (jobId, snap, now) => {
      // Fail only completion writes (nothing running afterwards); dispatch writes still succeed.
      if (outage && snap.counters.running === 0) throw new Error('injected write outage');
      save(jobId, snap, now);
    };
    let limited = false;
    const handler = fakeHandler({
      operation: 'registry',
      sourceKey: () => 'registry:shared',
      execute: (item, ctx) => {
        if (!limited) {
          limited = true;
          outage = true;
          setTimeout(() => {
            outage = false;
          }, 100);
          return rateLimited(item, ctx, 400);
        }
        return registryResult(item, ctx);
      },
    });
    t.registry.use(handler);
    const job = scan(t, ['a.com', 'b.com']);
    const done = await t.finished(job.id, 5000);
    expect(done.state).toBe('completed');
    const [first, ...later] = handler.calls;
    expect(first!.item.subject).toBe('a.com');
    for (const call of later) expect(call.at - first!.at).toBeGreaterThanOrEqual(395);
    expect(t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM source_cooldowns WHERE source_key = 'registry:shared'")!.n).toBe(1);
    expect(t.events.read(0, { types: ['source.cooldown'] })).toHaveLength(1);
  });

  it('completes a job at stop when its last result is saved by the stop flush', async () => {
    t = await createJobsApp();
    const store = t.app.get(JobStore);
    const save = store.saveRun.bind(store);
    let outage = true;
    store.saveRun = (jobId, snap, now) => {
      if (outage && snap.counters.finished >= 1) throw new Error('injected write outage');
      save(jobId, snap, now);
    };
    const handler = fakeHandler({ operation: 'registry' });
    t.registry.use(handler);
    const job = scan(t, ['a.com']);
    const notified: string[] = [];
    t.jobs.onFinished((j) => notified.push(j.state));
    await waitFor(() => handler.calls.length === 1, 5000, 'call');
    await new Promise((r) => setTimeout(r, 20));
    outage = false;
    await t.app.get(JobScheduler).stop();
    expect(t.jobs.get(job.id).state).toBe('completed');
    expect(notified).toEqual(['completed']);
  });

  it('recovers each job independently when one recovery write fails', async () => {
    t = await createJobsApp();
    t.registry.use(fakeHandler({ operation: 'registry' }));
    const a = await t.finished(scan(t, ['a.com']).id);
    const b = await t.finished(scan(t, ['b.com']).id);
    t.db.run(`UPDATE jobs SET state = 'running' WHERE id IN (?, ?)`, [a.id, b.id]);
    const store = t.app.get(JobStore);
    const save = store.saveRun.bind(store);
    store.saveRun = (jobId, snap, now) => {
      if (jobId === a.id) throw new Error('injected write failure');
      save(jobId, snap, now);
    };
    const recovered = t.app.get(JobScheduler).recover();
    expect(recovered.map((j) => [j.id, j.state])).toEqual([[b.id, 'interrupted']]);
    expect(t.jobs.get(a.id).state).toBe('running');
  });

  it('interrupts jobs still awaiting admission and runs one stop when re-entered', async () => {
    t = await createJobsApp();
    t.registry.use(fakeHandler({ operation: 'registry' }));
    const scheduler = t.app.get(JobScheduler);
    const notified: string[] = [];
    t.jobs.onFinished((job) => {
      notified.push(`${job.id}:${job.state}`);
      void scheduler.stop();
    });
    const job = t.db.transaction(() => scan(t, ['a.com']));
    // Stop before the admission microtask runs and before any call starts.
    await scheduler.stop();
    expect(t.jobs.get(job.id).state).toBe('interrupted');
    expect(notified).toEqual([`${job.id}:interrupted`]);
    expect(() => scan(t, ['b.com'])).toThrow(/stopping/);
  });

  it('starts jobs submitted inside a caller transaction only after it commits', async () => {
    t = await createJobsApp();
    const handler = fakeHandler({ operation: 'registry' });
    t.registry.use(handler);
    const committed = t.db.transaction(() => scan(t, ['kept.com']));
    expect((await t.finished(committed.id)).state).toBe('completed');

    let rolledBack = '';
    expect(() =>
      t.db.transaction(() => {
        rolledBack = scan(t, ['dropped.com']).id;
        throw new Error('caller failed');
      }),
    ).toThrow('caller failed');
    await new Promise((r) => setTimeout(r, 50));
    expect(t.db.get('SELECT id FROM jobs WHERE id = ?', [rolledBack])).toBeUndefined();
    expect(handler.calls.map((c) => c.item.subject)).toEqual(['kept.com']);
    expect(() => t.db.transaction(() => t.jobs.cancel(committed.id))).toThrow(/inside another transaction/);
  });

  it('refuses new work from listeners while stopping', async () => {
    t = await createJobsApp({ stopGraceMs: 50 });
    const hold = gate();
    t.registry.use(
      fakeHandler({
        operation: 'registry',
        execute: async (item, ctx) => {
          await hold.promise;
          return registryResult(item, ctx);
        },
      }),
    );
    scan(t, ['held.com']);
    const outcomes: string[] = [];
    t.jobs.onFinished((job) => {
      try {
        scan(t, ['late.com']);
        outcomes.push(`${job.state}:accepted`);
      } catch (error) {
        outcomes.push(`${job.state}:${(error as { code?: string }).code}`);
      }
    });
    await waitFor(() => t.db.get(`SELECT id FROM job_items WHERE state = 'running'`), 5000, 'item running');
    await t.close();
    t = undefined as unknown as JobsTestApp;
    expect(outcomes).toEqual(['interrupted:unavailable']);
    hold.open();
  });

  it('applies a raised global budget to running jobs at once', async () => {
    t = await createJobsApp({ settings: { ...TEST_SETTINGS, concurrency: { ...TEST_SETTINGS.concurrency, global: 1 } } });
    const hold = gate();
    let inFlight = 0;
    const handler = fakeHandler({
      operation: 'registry',
      execute: async (item, ctx) => {
        inFlight += 1;
        await hold.promise;
        inFlight -= 1;
        return registryResult(item, ctx);
      },
    });
    t.registry.use(handler);
    const job = scan(t, domains(6));
    await waitFor(() => inFlight === 1, 5000, 'one call in flight');
    await new Promise((r) => setTimeout(r, 30));
    expect(inFlight).toBe(1);
    t.settings.patch({ concurrency: { global: 3 } });
    await waitFor(() => inFlight === 3, 5000, 'three calls in flight');
    hold.open();
    expect((await t.finished(job.id)).counters.finished).toBe(6);
  });

  it('takes turns between jobs when the global budget is the limit', async () => {
    t = await createJobsApp({ settings: { ...TEST_SETTINGS, concurrency: { ...TEST_SETTINGS.concurrency, global: 1 } } });
    const hold = gate();
    const handler = fakeHandler({
      operation: 'registry',
      execute: async (item, ctx) => {
        await hold.promise;
        return registryResult(item, ctx);
      },
    });
    t.registry.use(handler);
    const a = scan(t, domains(4, ['com']));
    const b = scan(t, domains(4, ['net']));
    hold.open();
    await Promise.all([t.finished(a.id), t.finished(b.id)]);
    expect(handler.calls.map((c) => c.item.suffix)).toEqual(['com', 'net', 'com', 'net', 'com', 'net', 'com', 'net']);
  });
});
