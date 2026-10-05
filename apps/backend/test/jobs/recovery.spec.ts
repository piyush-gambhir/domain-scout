import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/storage/database.js';
import { DATABASE_FILE } from '../../src/storage/storage.module.js';
import { TEST_SETTINGS, createJobsApp, fakeHandler, gate, registryResult, waitFor, type JobsTestApp } from './helpers.js';

function rows(t: JobsTestApp, jobId: string) {
  return t.db.all<{ subject: string; state: string; attempts: number; finished_at: string | null; registry_observation_id: string | null }>(
    'SELECT subject, state, attempts, finished_at, registry_observation_id FROM job_items WHERE job_id = ? ORDER BY seq',
    [jobId],
  );
}

const SERIAL = { ...TEST_SETTINGS, concurrency: { ...TEST_SETTINGS.concurrency, global: 1 } };

describe('restart recovery', () => {
  let t: JobsTestApp | undefined;
  let dataDir: string | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it('interrupts in-flight work on stop and resumes after restart without repeating finished items', async () => {
    t = await createJobsApp({ keepData: true, settings: SERIAL, stopGraceMs: 100 });
    dataDir = t.dataDir;
    const hold = gate();
    const first = fakeHandler({
      operation: 'registry',
      execute: async (item, ctx) => {
        if (item.subject === 'c.com') await hold.promise;
        return registryResult(item, ctx);
      },
    });
    t.registry.use(first);
    const job = t.jobs.submit({ type: 'registry_scan', input: { domains: ['a.com', 'b.com', 'c.com', 'd.com'], format: 'auto', extensions: [] }, recheck: false });
    await waitFor(() => first.calls.some((c) => c.item.subject === 'c.com'), 5000, 'c.com in flight');
    const before = rows(t, job.id);
    await t.close(); // grace period elapses while c.com is held, so it is aborted

    t = await createJobsApp({ dataDir, keepData: true, settings: SERIAL });
    const second = fakeHandler({ operation: 'registry' });
    t.registry.use(second);
    const stopped = t.jobs.get(job.id);
    expect(stopped.state).toBe('interrupted');
    expect(stopped.counters).toMatchObject({ finished: 2, interrupted: 1, pending: 1, running: 0 });
    expect(rows(t, job.id).map((r) => [r.subject, r.state, r.attempts])).toEqual([
      ['a.com', 'finished', 1],
      ['b.com', 'finished', 1],
      ['c.com', 'interrupted', 0],
      ['d.com', 'pending', 0],
    ]);
    expect(t.jobEvents(job.id).at(-1)?.type).toBe('job.updated');

    await t.api.post(`/jobs/${job.id}/resume`).expect(200);
    const done = await t.finished(job.id);
    expect(done.state).toBe('completed');
    expect(second.calls.map((c) => c.item.subject)).toEqual(['c.com', 'd.com']);
    const after = rows(t, job.id);
    // Finished items keep their original evidence and check times.
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    hold.open();
  });

  it('lets in-flight calls finish within the stop grace period', async () => {
    t = await createJobsApp({ keepData: true, settings: SERIAL, stopGraceMs: 2000 });
    dataDir = t.dataDir;
    const handler = fakeHandler({
      operation: 'registry',
      execute: async (item, ctx) => {
        await new Promise((r) => setTimeout(r, 50));
        return registryResult(item, ctx);
      },
    });
    t.registry.use(handler);
    const job = t.jobs.submit({ type: 'registry_scan', input: { domains: ['a.com', 'b.com', 'c.com'], format: 'auto', extensions: [] }, recheck: false });
    await waitFor(() => handler.calls.length > 0, 5000, 'first call');
    await t.close();
    t = await createJobsApp({ dataDir, keepData: true, settings: SERIAL });
    const stopped = t.jobs.get(job.id);
    expect(stopped.state).toBe('interrupted');
    expect(stopped.counters).toMatchObject({ finished: 1, interrupted: 0, pending: 2 });
  });

  it('recovers jobs left running by a crash as interrupted', async () => {
    t = await createJobsApp({ keepData: true });
    dataDir = t.dataDir;
    t.registry.use(fakeHandler({ operation: 'registry' }));
    const job = t.jobs.submit({ type: 'registry_scan', input: { domains: ['a.com', 'b.com'], format: 'auto', extensions: [] }, recheck: false });
    await t.finished(job.id);
    await t.close();
    t = undefined;

    // Simulate a crash mid-run: the job and one item still marked running.
    const db = new Database(join(dataDir, DATABASE_FILE));
    db.run(`UPDATE jobs SET state = 'running', finished_at = NULL WHERE id = ?`, [job.id]);
    db.run(`UPDATE job_items SET state = 'running', attempts = 1 WHERE job_id = ? AND subject = 'b.com'`, [job.id]);
    db.close();

    t = await createJobsApp({ dataDir, keepData: true });
    const recovered = t.jobs.get(job.id);
    expect(recovered.state).toBe('interrupted');
    expect(recovered.counters).toMatchObject({ finished: 1, interrupted: 1, running: 0 });
    expect(rows(t, job.id).find((r) => r.subject === 'b.com')).toMatchObject({ state: 'interrupted', attempts: 0 });
    const handler = fakeHandler({ operation: 'registry' });
    t.registry.use(handler);
    await t.api.post(`/jobs/${job.id}/resume`).expect(200);
    expect((await t.finished(job.id)).state).toBe('completed');
    expect(handler.calls.map((c) => c.item.subject)).toEqual(['b.com']);
  });

  it('keeps source cooldowns across restarts', async () => {
    const settings = { ...TEST_SETTINGS, concurrency: { ...TEST_SETTINGS.concurrency, maxCooldownWaitSeconds: 1 } };
    t = await createJobsApp({ keepData: true, settings });
    dataDir = t.dataDir;
    t.registry.use(
      fakeHandler({
        operation: 'registry',
        sourceKey: () => 'registry:verisign',
        execute: (item, ctx) =>
          registryResult(item, ctx, 'rate_limited', { cooldownUntil: new Date(ctx.now().getTime() + 3_600_000).toISOString() }),
      }),
    );
    await t.finished(t.jobs.submit({ type: 'registry_scan', input: { domains: ['a.com'], format: 'auto', extensions: [] }, recheck: false }).id);
    await t.close();

    t = await createJobsApp({ dataDir, keepData: true, settings });
    const handler = fakeHandler({ operation: 'registry', sourceKey: () => 'registry:verisign' });
    t.registry.use(handler);
    const job = await t.finished(t.jobs.submit({ type: 'registry_scan', input: { domains: ['b.com'], format: 'auto', extensions: [] }, recheck: false }).id);
    expect(job.counters.outcomes).toEqual({ rate_limited: 1 });
    expect(job.nextRetryAt).not.toBeNull();
    expect(handler.calls).toHaveLength(0);
  });
});
