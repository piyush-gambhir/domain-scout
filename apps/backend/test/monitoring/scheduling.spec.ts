import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WatchResponse, WatchRunListResponse, type Watch } from '@domain-scout/contracts';
import { FakeClock } from '../../src/core/clock.js';
import { InputPreviewer, JobLifecycle, JobSubmitter, ProviderDirectory } from '../../src/core/ports.js';
import { MonitoringModule } from '../../src/monitoring/monitoring.module.js';
import { WatchScheduler } from '../../src/monitoring/watch-scheduler.service.js';
import { EventsService } from '../../src/events/events.service.js';
import { Database } from '../../src/storage/database.js';
import { SettingsService } from '../../src/system/settings.service.js';
import { createModuleApp, type ModuleApp } from '../evidence/harness.js';
import { FakeDirectory, FakeLifecycle, FakePreviewer, fakeJobsProvider, type FakeJobs } from '../evidence/fakes.js';

const T0 = '2026-10-05T12:00:00.000Z';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function boot(clock: FakeClock, dataDir?: string) {
  const lifecycle = new FakeLifecycle();
  const t = await createModuleApp({
    modules: [MonitoringModule],
    clock,
    dataDir,
    providers: [
      { provide: InputPreviewer, useValue: new FakePreviewer() },
      fakeJobsProvider,
      { provide: JobLifecycle, useValue: lifecycle },
      { provide: ProviderDirectory, useValue: new FakeDirectory() },
    ],
  });
  const jobs = t.get(JobSubmitter) as FakeJobs;
  return { t, jobs, lifecycle, http: request(t.app.getHttpServer()), scheduler: t.get(WatchScheduler) };
}

async function createWatch(http: ReturnType<typeof request>, body: Record<string, unknown> = {}): Promise<Watch> {
  const res = await http
    .post('/api/v1/watches')
    .send({ name: 'Shortlist', domains: ['example.com', 'xn--bcher-kva.de', 'example.com'], intervalMinutes: 1440, ...body })
    .expect(201);
  return WatchResponse.parse(res.body).data;
}

describe('watch scheduling', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  let clock: FakeClock;

  beforeEach(async () => {
    clock = new FakeClock(new Date(T0));
    ctx = await boot(clock);
  });
  afterEach(() => ctx.t.close());

  it('validates watches and records interval, destinations and price options', async () => {
    const watch = await createWatch(ctx.http, { providerIds: ['porkbun'], includeCatalogPrices: true });
    expect(watch).toMatchObject({
      domains: ['example.com', 'xn--bcher-kva.de'],
      intervalMinutes: 1440,
      state: 'active',
      includeRegistry: true,
      includeCatalogPrices: true,
      nextRunAt: T0,
      missedRuns: 0,
      unreadNotices: 0,
    });
    expect(watch.destinations).toEqual(['registry:com', 'registry:de', 'provider:porkbun']);
    await ctx.http.post('/api/v1/watches').send({ name: 'x', domains: ['a.b.example.com'] }).expect(400);
    await ctx.http.post('/api/v1/watches').send({ name: 'x', domains: ['example.com'], providerIds: ['nope'] }).expect(400);
    await ctx.http.post('/api/v1/watches').send({ name: 'x', domains: ['example.com'], includeRegistry: false }).expect(400);
    await ctx.http.post('/api/v1/watches').send({ name: 'x', domains: ['example.com'], intervalMinutes: 5 }).expect(400);
    await ctx.http.post('/api/v1/watches').send({ name: 'x', domains: ['example.com'], includeCatalogPrices: true }).expect(400);
  });

  it('uses the configured default interval when a watch omits it', async () => {
    ctx.t.get(SettingsService).patch({ monitoring: { defaultIntervalMinutes: 60 } });
    const res = await ctx.http.post('/api/v1/watches').send({ name: 'Hourly', domains: ['example.com'] }).expect(201);
    expect(WatchResponse.parse(res.body).data.intervalMinutes).toBe(60);
    expect((await createWatch(ctx.http, { intervalMinutes: 30 })).intervalMinutes).toBe(30);
  });

  it('submits due watches through the job engine once per interval', async () => {
    const watch = await createWatch(ctx.http, { providerIds: ['porkbun'] });
    const started = ctx.scheduler.tick();
    expect(started).toHaveLength(1);
    expect(ctx.jobs.submitted[0]!.request).toEqual({
      type: 'watch',
      watchId: watch.id,
      label: 'Watch: Shortlist',
      domains: ['example.com', 'xn--bcher-kva.de'],
      includeRegistry: true,
      providerIds: ['porkbun'],
      includeCatalogPrices: false,
    });
    expect(ctx.jobs.submitted[0]!.options).toEqual({ watchId: watch.id });

    // Still running: later ticks do not pile up runs, even once the next slot is due.
    clock.advance(DAY + MINUTE);
    expect(ctx.scheduler.tick()).toHaveLength(0);

    const jobId = started[0]!;
    ctx.lifecycle.emit(ctx.jobs.finish(jobId, 'completed', clock.iso()));
    expect(ctx.scheduler.tick()).toHaveLength(1);
    expect(ctx.scheduler.tick()).toHaveLength(0);

    const current = WatchResponse.parse((await ctx.http.get(`/api/v1/watches/${watch.id}`).expect(200)).body).data;
    expect(current.lastJobId).toBe(ctx.jobs.submitted[1]!.job.id);
    expect(current.nextRunAt).toBe(new Date(Date.parse(T0) + 2 * DAY).toISOString());

    const runs = WatchRunListResponse.parse((await ctx.http.get(`/api/v1/watches/${watch.id}/runs`).expect(200)).body).data;
    expect(runs.map((r) => r.status)).toEqual(['running', 'completed']);
    expect(runs[1]).toMatchObject({ jobId, scheduledFor: T0, changes: 0, failures: 0 });
  });

  it('closes a run from job state if the completion notification was missed', async () => {
    await createWatch(ctx.http);
    const [jobId] = ctx.scheduler.tick();
    ctx.jobs.finish(jobId!, 'completed_with_errors', clock.iso(), { unresolved: 2 });
    clock.advance(DAY);
    expect(ctx.scheduler.tick()).toHaveLength(1);
  });

  it('pauses and resumes without running while paused', async () => {
    const watch = await createWatch(ctx.http);
    const paused = WatchResponse.parse((await ctx.http.post(`/api/v1/watches/${watch.id}/pause`).expect(200)).body).data;
    expect(paused).toMatchObject({ state: 'paused', nextRunAt: null });
    clock.advance(3 * DAY);
    expect(ctx.scheduler.tick()).toHaveLength(0);

    const resumed = WatchResponse.parse((await ctx.http.post(`/api/v1/watches/${watch.id}/resume`).expect(200)).body).data;
    expect(resumed).toMatchObject({ state: 'active', nextRunAt: clock.iso(), missedRuns: 0 });
    expect(ctx.scheduler.tick()).toHaveLength(1);
  });

  it('edits watches, reschedules on interval change and deletes them', async () => {
    const watch = await createWatch(ctx.http);
    ctx.scheduler.tick();
    const patched = WatchResponse.parse(
      (await ctx.http.patch(`/api/v1/watches/${watch.id}`).send({ intervalMinutes: 60, name: 'Hourly' }).expect(200)).body,
    ).data;
    expect(patched).toMatchObject({ name: 'Hourly', intervalMinutes: 60, nextRunAt: new Date(Date.parse(T0) + 60 * MINUTE).toISOString() });
    const list = (await ctx.http.get('/api/v1/watches?limit=10').expect(200)).body;
    expect(list.total).toBe(1);
    await ctx.http.delete(`/api/v1/watches/${watch.id}`).expect(200);
    await ctx.http.get(`/api/v1/watches/${watch.id}`).expect(404);
  });

  it('runs on demand, honours Idempotency-Key replays and refuses overlapping runs', async () => {
    const watch = await createWatch(ctx.http);
    const first = await ctx.http.post(`/api/v1/watches/${watch.id}/run`).set('Idempotency-Key', 'run-1').expect(201);
    expect(ctx.jobs.submitted[0]!.options).toEqual({ watchId: watch.id, idempotencyKey: 'run-1', operationId: 'runWatch' });
    const replay = await ctx.http.post(`/api/v1/watches/${watch.id}/run`).set('Idempotency-Key', 'run-1').expect(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(ctx.jobs.submitted).toHaveLength(1);
    await ctx.http.post(`/api/v1/watches/${watch.id}/run`).expect(409);

    ctx.lifecycle.emit(ctx.jobs.finish(first.body.data.id, 'completed', clock.iso()));
    const after = await ctx.http.post(`/api/v1/watches/${watch.id}/run`).set('Idempotency-Key', 'run-1').expect(201);
    expect(after.body.data.id).toBe(first.body.data.id);
    expect(ctx.jobs.submitted).toHaveLength(1);

    // A manual run resets the cadence; the scheduler does not also fire the original slot.
    const current = WatchResponse.parse((await ctx.http.get(`/api/v1/watches/${watch.id}`).expect(200)).body).data;
    expect(current.nextRunAt).toBe(new Date(Date.parse(T0) + DAY).toISOString());
    expect(ctx.scheduler.tick()).toHaveLength(0);
  });

  it('keeps the idempotency key when a manual run finishes during submission', async () => {
    const watch = await createWatch(ctx.http);
    ctx.jobs.afterSubmit = (job) => ctx.lifecycle.emit(ctx.jobs.finish(job.id, 'completed', clock.iso()));
    const first = await ctx.http.post(`/api/v1/watches/${watch.id}/run`).set('Idempotency-Key', 'sync-1').expect(201);
    ctx.jobs.afterSubmit = null;
    const before = WatchResponse.parse((await ctx.http.get(`/api/v1/watches/${watch.id}`).expect(200)).body).data;
    clock.advance(MINUTE);
    const replay = await ctx.http.post(`/api/v1/watches/${watch.id}/run`).set('Idempotency-Key', 'sync-1').expect(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(ctx.jobs.submitted).toHaveLength(1);
    const after = WatchResponse.parse((await ctx.http.get(`/api/v1/watches/${watch.id}`).expect(200)).body).data;
    expect(after.nextRunAt).toBe(before.nextRunAt);
    const runs = WatchRunListResponse.parse((await ctx.http.get(`/api/v1/watches/${watch.id}/runs`).expect(200)).body).data;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'completed', jobId: first.body.data.id });
  });

  it('emits watch.changed events for state changes', async () => {
    const watch = await createWatch(ctx.http);
    await ctx.http.post(`/api/v1/watches/${watch.id}/pause`).expect(200);
    const events = ctx.t.get(EventsService).read(0, { watchId: watch.id });
    expect(events.map((e) => e.type)).toEqual(['watch.changed', 'watch.changed']);
    expect((events[1]!.payload as Watch).state).toBe('paused');
  });
});

describe('missed runs while the backend is stopped', () => {
  it('records missed intervals and performs exactly one catch-up run per watch', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ds-watch-downtime-'));
    try {
      const clock = new FakeClock(new Date(T0));
      const first = await boot(clock, dataDir);
      const daily = await createWatch(first.http);
      const paused = await createWatch(first.http, { name: 'Paused' });
      await first.http.post(`/api/v1/watches/${paused.id}/pause`).expect(200);
      const [jobId] = first.scheduler.tick();
      first.lifecycle.emit(first.jobs.finish(jobId!, 'completed', clock.iso()));
      // Stop with a second run in progress so restart has to close it.
      clock.advance(DAY);
      const [inFlight] = first.scheduler.tick();
      expect(inFlight).toBeDefined();
      await first.t.close();

      // Down until T0 + 4.5 days: the slots at T0 + 2, 3 and 4 days were missed.
      clock.advance(3.5 * DAY);
      const second = await boot(clock, dataDir);
      expect(second.jobs.submitted).toHaveLength(1);
      expect(second.jobs.submitted[0]!.request).toMatchObject({ type: 'watch', watchId: daily.id });

      const watch = WatchResponse.parse((await second.http.get(`/api/v1/watches/${daily.id}`).expect(200)).body).data;
      expect(watch.missedRuns).toBe(3);
      expect(watch.nextRunAt).toBe(new Date(Date.parse(T0) + 5 * DAY).toISOString());

      const runs = WatchRunListResponse.parse((await second.http.get(`/api/v1/watches/${daily.id}/runs`).expect(200)).body).data;
      const byStatus = runs.map((r) => r.status).sort();
      expect(byStatus).toEqual(['cancelled', 'catch_up', 'completed', 'missed']);
      const missed = runs.find((r) => r.status === 'missed')!;
      expect(missed.scheduledFor).toBe(new Date(Date.parse(T0) + 2 * DAY).toISOString());
      expect(missed.note).toContain('3 scheduled checks');
      expect(runs.find((r) => r.status === 'cancelled')!.jobId).toBe(inFlight);
      expect(runs.find((r) => r.status === 'catch_up')!.note).toContain('Catch-up run after 3 missed checks');

      // No replay of every missed interval: further ticks before the next slot start nothing.
      expect(second.scheduler.tick()).toHaveLength(0);
      second.lifecycle.emit(second.jobs.finish(second.jobs.submitted[0]!.job.id, 'completed', clock.iso()));
      expect(second.scheduler.tick()).toHaveLength(0);

      // The next regular run clears the missed count.
      clock.set(new Date(Date.parse(T0) + 5 * DAY));
      expect(second.scheduler.tick()).toHaveLength(1);
      const later = WatchResponse.parse((await second.http.get(`/api/v1/watches/${daily.id}`).expect(200)).body).data;
      expect(later.missedRuns).toBe(0);

      // The paused watch was never counted or run.
      const pausedNow = WatchResponse.parse((await second.http.get(`/api/v1/watches/${paused.id}`).expect(200)).body).data;
      expect(pausedNow).toMatchObject({ state: 'paused', missedRuns: 0, lastRunAt: null });
      await second.t.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('runs whose job was deleted', () => {
  it('are closed so the watch is not blocked', async () => {
    const clock = new FakeClock(new Date(T0));
    const ctx = await boot(clock);
    try {
      const watch = await createWatch(ctx.http);
      const [jobId] = ctx.scheduler.tick();
      // Deleting the job sets watch_runs.job_id to NULL through the foreign key.
      ctx.t.get(Database).run('DELETE FROM jobs WHERE id = ?', [jobId!]);
      clock.advance(DAY);
      expect(ctx.scheduler.tick()).toHaveLength(1);
      const runs = WatchRunListResponse.parse((await ctx.http.get(`/api/v1/watches/${watch.id}/runs`).expect(200)).body).data;
      expect(runs.find((r) => r.jobId === null)).toMatchObject({ status: 'cancelled', note: 'The job for this run was deleted.' });
    } finally {
      await ctx.t.close();
    }
  });
});
