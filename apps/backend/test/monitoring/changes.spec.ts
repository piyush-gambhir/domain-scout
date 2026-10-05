import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoticeListResponse, WatchResponse, WatchRunListResponse, type Notice, type Watch } from '@domain-scout/contracts';
import { FakeClock } from '../../src/core/clock.js';
import { InputPreviewer, JobLifecycle, JobSubmitter, ProviderDirectory } from '../../src/core/ports.js';
import { EventsService } from '../../src/events/events.service.js';
import { MonitoringModule } from '../../src/monitoring/monitoring.module.js';
import { WatchScheduler } from '../../src/monitoring/watch-scheduler.service.js';
import { EvidenceRepository } from '../../src/storage/evidence.js';
import { createModuleApp, type ModuleApp } from '../evidence/harness.js';
import {
  EvidenceFixtures,
  FakeDirectory,
  FakeLifecycle,
  FakePreviewer,
  fakeJobsProvider,
  type FakeJobs,
} from '../evidence/fakes.js';

const T0 = '2026-10-05T12:00:00.000Z';
const MINUTE = 60_000;

describe('watch change detection', () => {
  let t: ModuleApp;
  let clock: FakeClock;
  let jobs: FakeJobs;
  let lifecycle: FakeLifecycle;
  let scheduler: WatchScheduler;
  let fx: EvidenceFixtures;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    clock = new FakeClock(new Date(T0));
    lifecycle = new FakeLifecycle();
    t = await createModuleApp({
      modules: [MonitoringModule],
      clock,
      providers: [
        { provide: InputPreviewer, useValue: new FakePreviewer() },
        fakeJobsProvider,
        { provide: JobLifecycle, useValue: lifecycle },
        { provide: ProviderDirectory, useValue: new FakeDirectory() },
      ],
    });
    jobs = t.get(JobSubmitter) as FakeJobs;
    scheduler = t.get(WatchScheduler);
    fx = new EvidenceFixtures(t.get(EvidenceRepository));
    http = request(t.app.getHttpServer());
  });
  afterEach(() => t.close());

  async function watch(body: Record<string, unknown> = {}): Promise<Watch> {
    const res = await http.post('/api/v1/watches').send({ name: 'W', domains: ['example.com'], ...body }).expect(201);
    return WatchResponse.parse(res.body).data;
  }

  /** One watch run: evidence written by `observe` is recorded as this job's own evidence. */
  function run(
    watchId: string,
    observe: (at: string) => void,
    state: 'completed' | 'completed_with_errors' = 'completed',
    options: { reusedRegistry?: boolean } = {},
  ) {
    const job = scheduler.runNow(watchId);
    clock.advance(MINUTE);
    const before = fx.created.length;
    observe(clock.iso());
    jobs.attach(job.id, fx.created.slice(before), options);
    clock.advance(MINUTE);
    const finished = jobs.finish(job.id, state, clock.iso(), state === 'completed' ? {} : { unresolved: 1 });
    lifecycle.emit(finished);
    clock.advance(MINUTE);
    return finished;
  }

  async function notices(watchId?: string): Promise<Notice[]> {
    const res = await http.get(`/api/v1/notices${watchId ? `?watchId=${watchId}` : ''}`).expect(200);
    return NoticeListResponse.parse(res.body).data;
  }

  it('creates exactly one notice for a registry transition and none for failures or repeats', async () => {
    const before = fx.registry('example.com', 'registered', '2026-10-05T11:00:00.000Z');
    const w = await watch();

    // Network failure, timeout and block: unresolved outcomes never create notices.
    run(w.id, (at) => {
      fx.registry('example.com', 'rate_limited', at);
      fx.registry('example.com', 'inconclusive', at, { reason: 'Timed out after 15000 ms' });
      fx.registry('example.com', 'blocked', at);
    }, 'completed_with_errors');
    expect(await notices()).toHaveLength(0);

    let after = '';
    const changedJob = run(w.id, (at) => {
      after = fx.registry('example.com', 'no_record', at);
    });
    const created = await notices();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      watchId: w.id,
      domain: 'example.com',
      type: 'availability_changed',
      before: { kind: 'registry', id: before, value: 'registered', source: 'https://rdap.test/' },
      after: { kind: 'registry', id: after, value: 'no_record' },
      readAt: null,
    });
    expect(created[0]!.summary).toContain('no registry record');
    expect(created[0]!.summary).not.toMatch(/available/i);

    // Reprocessing the same job and a repeated identical observation add nothing.
    lifecycle.emit(changedJob);
    run(w.id, (at) => fx.registry('example.com', 'no_record', at));
    expect(await notices()).toHaveLength(1);

    const runs = WatchRunListResponse.parse((await http.get(`/api/v1/watches/${w.id}/runs`).expect(200)).body).data;
    expect(runs.map((r) => [r.status, r.changes, r.failures])).toEqual([
      ['completed', 0, 0],
      ['completed', 1, 0],
      ['completed_with_errors', 0, 1],
    ]);

    const events = t.get(EventsService).read(0, { watchId: w.id, types: ['notice.created'] });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as Notice).id).toBe(created[0]!.id);
    expect(events[0]!.jobId).toBe(changedJob.id);
    const current = WatchResponse.parse((await http.get(`/api/v1/watches/${w.id}`).expect(200)).body).data;
    expect(current.unreadNotices).toBe(1);
  });

  it('ignores evidence from other jobs and reused cached registry evidence', async () => {
    fx.registry('example.com', 'registered', '2026-10-05T11:00:00.000Z');
    const w = await watch();
    // The watch's own check times out while an unrelated scan records no_record in the same window.
    run(w.id, (at) => {
      fx.registry('example.com', 'inconclusive', at, { reason: 'Timed out' });
      const other = jobs.submit({ type: 'registry_scan', input: { extensions: [], format: 'auto' }, recheck: false } as never);
      const index = fx.created.length;
      fx.registry('example.com', 'no_record', at);
      jobs.attach(other.id, fx.created.splice(index, 1));
    }, 'completed_with_errors');
    expect(await notices()).toHaveLength(0);

    // A watch job that reused fresh cached evidence did not observe anything new.
    const cached = fx.registry('example.com', 'registered', clock.iso());
    fx.created.pop();
    const job = scheduler.runNow(w.id);
    jobs.attach(job.id, [{ table: 'observation', kind: 'registry', id: cached }], { reusedRegistry: true });
    lifecycle.emit(jobs.finish(job.id, 'completed', clock.iso()));
    expect(await notices()).toHaveLength(0);
  });

  it('orders evidence with identical timestamps deterministically', async () => {
    fx.registry('example.com', 'no_record', '2026-10-05T11:00:00.000Z');
    const w = await watch();
    run(w.id, (at) => {
      fx.registry('example.com', 'no_record', at, { id: '00000000-0000-4000-8000-000000000001' });
      // An unrelated scan at the same instant sorts after the watch's own observation.
      fx.registry('example.com', 'registered', at, { id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
      fx.created.pop();
    });
    expect(await notices()).toHaveLength(0);
  });

  it('only compares confirmations from the watched providers with resolved statuses', async () => {
    fx.confirmation('example.com', 'porkbun', 'unavailable', '2026-10-05T11:00:00.000Z');
    const w = await watch({ providerIds: ['porkbun'], includeRegistry: false });

    run(w.id, (at) => {
      fx.confirmation('example.com', 'porkbun', 'unknown', at); // e.g. credential_required or an error
      fx.confirmation('example.com', 'namecheap', 'available', at); // not part of this watch
    });
    expect(await notices()).toHaveLength(0);

    run(w.id, (at) => fx.confirmation('example.com', 'porkbun', 'available', at));
    const created = await notices();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: 'confirmation_changed',
      before: { kind: 'confirmation', value: 'unavailable', source: 'provider:porkbun' },
      after: { kind: 'confirmation', value: 'available' },
    });
  });

  it('notices only comparable price changes with both amounts known', async () => {
    fx.offer({ providerId: 'porkbun', domain: 'example.com', suffix: 'com', registration: '12.00', at: '2026-10-05T11:00:00.000Z' });
    const w = await watch({ providerIds: ['porkbun'], includeRegistry: false });

    run(w.id, (at) => {
      fx.offer({ providerId: 'porkbun', domain: 'example.com', suffix: 'com', registration: null, at }); // missing price
      fx.offer({ providerId: 'porkbun', domain: 'example.com', suffix: 'com', registration: '12.0', at }); // same amount
      fx.offer({ providerId: 'porkbun', domain: 'example.com', suffix: 'com', registration: '14.00', currency: 'EUR', at });
      fx.offer({ providerId: 'porkbun', domain: 'example.com', suffix: 'com', registration: '20.00', termYears: 2, at });
      fx.offer({ providerId: 'porkbun', domain: 'example.com', suffix: 'com', registration: '9.00', promotional: true, at });
      fx.offer({ providerId: 'dynadot', domain: 'example.com', suffix: 'com', registration: '1.00', at }); // other provider
    });
    expect(await notices()).toHaveLength(0);

    run(w.id, (at) => fx.offer({ providerId: 'porkbun', domain: 'example.com', suffix: 'com', registration: '13.50', at }));
    const created = await notices();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      domain: 'example.com',
      type: 'price_changed',
      before: { kind: 'offer', value: '12.0 USD' },
      after: { kind: 'offer', value: '13.50 USD' },
    });
  });

  it('never reports a changed promotion or renewal term as a price change (W02)', async () => {
    const spring = { description: 'Spring sale', requiresTermYears: null, expiresAt: '2026-11-01T00:00:00.000Z', restrictions: null };
    const base = { providerId: 'porkbun', domain: 'example.com', suffix: 'com', promotional: true };
    fx.offer({ ...base, registration: '5.00', promotion: spring, at: '2026-10-05T11:00:00.000Z' });
    fx.offer({ ...base, registration: '20.00', renewal: '20.00', promotional: false, at: '2026-10-05T11:00:00.000Z' });
    const w = await watch({ providerIds: ['porkbun'], includeRegistry: false });

    run(w.id, (at) => {
      // Different campaign conditions and a different renewal term are not comparable.
      fx.offer({ ...base, registration: '3.00', promotion: { ...spring, restrictions: 'New customers only' }, at });
      fx.offer({ ...base, registration: '4.00', promotion: { ...spring, requiresTermYears: 2 }, at });
      fx.offer({ ...base, registration: '25.00', renewal: '40.00', renewalYears: 2, promotional: false, at });
    });
    expect(await notices()).toHaveLength(0);

    // The same campaign at a new price is a comparable change.
    run(w.id, (at) => fx.offer({ ...base, registration: '6.00', promotion: spring, at }));
    const created = await notices();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ before: { value: '5.00 USD' }, after: { value: '6.00 USD' } });
  });

  it('tracks catalog prices once per suffix when requested', async () => {
    fx.offer({ providerId: 'porkbun', domain: null, suffix: 'com', registration: '10.00', at: '2026-10-05T11:00:00.000Z' });
    const w = await watch({ domains: ['example.com', 'example2.com'], providerIds: ['porkbun'], includeCatalogPrices: true, includeRegistry: false });
    run(w.id, (at) => fx.offer({ providerId: 'porkbun', domain: null, suffix: 'com', registration: '11.00', at }));
    const created = await notices();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ domain: '.com', type: 'price_changed', after: { value: '11.00 USD' } });
    expect(created[0]!.summary).toContain('published');
  });

  it('lists and marks notices read', async () => {
    fx.registry('example.com', 'no_record', '2026-10-05T11:00:00.000Z');
    const w = await watch();
    run(w.id, (at) => fx.registry('example.com', 'registered', at));
    run(w.id, (at) => fx.registry('example.com', 'no_record', at));
    expect(await notices(w.id)).toHaveLength(2);

    const unread = NoticeListResponse.parse((await http.get('/api/v1/notices?unread=true&limit=1').expect(200)).body);
    expect(unread.total).toBe(2);
    expect(unread.nextCursor).not.toBeNull();

    await http.post('/api/v1/notices/read').send({ ids: [unread.data[0]!.id] }).expect(200);
    expect(NoticeListResponse.parse((await http.get('/api/v1/notices?unread=true').expect(200)).body).total).toBe(1);
    await http.post('/api/v1/notices/read').send({ all: true }).expect(200);
    expect(NoticeListResponse.parse((await http.get('/api/v1/notices?unread=false').expect(200)).body).total).toBe(2);
    await http.post('/api/v1/notices/read').send({}).expect(400);
    const current = WatchResponse.parse((await http.get(`/api/v1/watches/${w.id}`).expect(200)).body).data;
    expect(current.unreadNotices).toBe(0);
  });

  it('marks only one watch\'s notices read with all and watchId', async () => {
    fx.registry('example.com', 'no_record', '2026-10-05T11:00:00.000Z');
    fx.registry('other.com', 'no_record', '2026-10-05T11:00:00.000Z');
    const a = await watch();
    const b = await watch({ domains: ['other.com'] });
    run(a.id, (at) => fx.registry('example.com', 'registered', at));
    run(b.id, (at) => fx.registry('other.com', 'registered', at));
    const start = t.get(EventsService).latestId();

    await http.post('/api/v1/notices/read').send({ all: true, watchId: a.id }).expect(200);
    const unread = NoticeListResponse.parse((await http.get('/api/v1/notices?unread=true').expect(200)).body).data;
    expect(unread.map((n) => n.watchId)).toEqual([b.id]);
    const changed = t.get(EventsService).read(start, { types: ['watch.changed'] }).map((e) => (e.payload as Watch).id);
    expect(changed).toEqual([a.id]);
    await http.post('/api/v1/notices/read').send({ all: true, watchId: '00000000-0000-4000-8000-000000000009' }).expect(404);
  });
});
