import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoticeListResponse, WatchResponse, WatchRunListResponse, type Notice, type Watch } from '@domain-scout/contracts';
import { ChangeDetector } from '../../src/monitoring/change-detector.service.js';
import { WatchScheduler } from '../../src/monitoring/watch-scheduler.service.js';
import { EvidenceRepository } from '../../src/storage/evidence.js';
import { createJobsApp, fakeHandler, gate, registryResult, waitFor, type JobsTestApp } from '../jobs/helpers.js';
import { offerWrite } from '../jobs/offer-fixture.js';

/** Watches driven through the real jobs engine (handlers are fakes; no network). */
describe('watches on the jobs engine', () => {
  let t: JobsTestApp | undefined;
  let dataDir: string | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  async function createWatch(app: JobsTestApp, body: Record<string, unknown>): Promise<Watch> {
    return WatchResponse.parse((await app.api.post('/watches').send({ name: 'W', domains: ['example.com'], ...body }).expect(201)).body).data;
  }
  async function notices(app: JobsTestApp): Promise<Notice[]> {
    return NoticeListResponse.parse((await app.api.get('/notices').expect(200)).body).data;
  }
  async function runs(app: JobsTestApp, watchId: string) {
    return WatchRunListResponse.parse((await app.api.get(`/watches/${watchId}/runs`).expect(200)).body).data;
  }
  async function runWatch(app: JobsTestApp, watchId: string) {
    const job = app.app.get(WatchScheduler).runNow(watchId);
    return app.finished(job.id);
  }

  it('notices a catalog price change from offers the catalog item links (persisted by the handler)', async () => {
    t = await createJobsApp();
    const app = t;
    let price = '10.00';
    app.registry.use(
      fakeHandler({ operation: 'quote', execute: () => ({ outcome: 'unavailable', resolved: true, evidence: [] }) }),
      // Like the catalog service: the refresh commits its fetch and offers itself, then reports
      // the offer ids for the engine to link to the item.
      fakeHandler({
        operation: 'catalog',
        execute: (item, ctx) => {
          const fetchedAt = ctx.now().toISOString();
          const fetchId = randomUUID();
          const offers = [
            offerWrite({ providerId: item.subject, domain: null, suffix: 'com', registration: price, observedAt: fetchedAt, catalogFetchId: fetchId }),
            offerWrite({ providerId: item.subject, domain: null, suffix: 'net', registration: price, observedAt: fetchedAt, catalogFetchId: fetchId }),
          ];
          app.db.transaction(() => {
            app.db.run("INSERT INTO catalog_fetches (id, provider_id, status, fetched_at, suffix_count, source) VALUES (?, ?, 'ok', ?, 2, 'test')", [
              fetchId,
              item.subject,
              fetchedAt,
            ]);
            for (const offer of offers) app.app.get(EvidenceRepository).insertOffer(offer);
          });
          return { outcome: 'updated', resolved: true, evidence: [], reused: { offerIds: offers.map((o) => o.id) } };
        },
      }),
    );
    const watch = await createWatch(app, { providerIds: ['porkbun'], includeRegistry: false, includeCatalogPrices: true });

    expect((await runWatch(app, watch.id)).state).toBe('completed');
    expect(await notices(app)).toHaveLength(0); // first observation: nothing to compare with

    price = '11.00';
    app.clock.advance(60_000);
    const second = await runWatch(app, watch.id);
    const created = await notices(app);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      domain: '.com',
      type: 'price_changed',
      before: { kind: 'offer', value: '10.00 USD' },
      after: { kind: 'offer', value: '11.00 USD' },
    });
    expect((await runs(app, watch.id))[0]).toMatchObject({ jobId: second.id, status: 'completed', changes: 1 });
  });

  it('detects changes of a watch job that finished before its completion was recorded, after a restart', async () => {
    t = await createJobsApp({ keepData: true });
    dataDir = t.dataDir;
    let outcome = 'registered';
    t.registry.use(fakeHandler({ operation: 'registry', execute: (item, ctx) => registryResult(item, ctx, outcome) }));
    const watch = await createWatch(t, { includeRegistry: true });
    await runWatch(t, watch.id);

    // The process stops after the job commits but before monitoring hears about it.
    t.app.get(WatchScheduler).onModuleDestroy();
    outcome = 'no_record';
    t.clock.advance(60_000);
    const crashed = await runWatch(t, watch.id);
    expect(crashed.state).toBe('completed');
    expect((await runs(t, watch.id))[0]).toMatchObject({ jobId: crashed.id, status: 'running' });
    await t.close();

    t = await createJobsApp({ dataDir, keepData: true });
    const created = await notices(t);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ domain: 'example.com', type: 'availability_changed', after: { value: 'no_record' } });
    expect((await runs(t, watch.id))[0]).toMatchObject({ jobId: crashed.id, status: 'completed', changes: 1, note: 'Started manually.' });
  });

  it('keeps a finished run open for the next tick when its startup processing fails', async () => {
    t = await createJobsApp({ keepData: true });
    dataDir = t.dataDir;
    let outcome = 'registered';
    t.registry.use(fakeHandler({ operation: 'registry', execute: (item, ctx) => registryResult(item, ctx, outcome) }));
    const watch = await createWatch(t, { includeRegistry: true });
    await runWatch(t, watch.id);
    t.app.get(WatchScheduler).onModuleDestroy();
    outcome = 'no_record';
    const crashed = await runWatch(t, watch.id);
    await t.close();

    // Change detection throws once during startup recovery.
    const detect = vi.spyOn(ChangeDetector.prototype, 'detect').mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    try {
      t = await createJobsApp({ dataDir, keepData: true });
      expect((await runs(t, watch.id))[0]).toMatchObject({ jobId: crashed.id, status: 'running' });
      expect(await notices(t)).toHaveLength(0);

      t.app.get(WatchScheduler).tick();
      expect((await runs(t, watch.id))[0]).toMatchObject({ jobId: crashed.id, status: 'completed', changes: 1 });
      expect(await notices(t)).toHaveLength(1);
    } finally {
      detect.mockRestore();
    }
  });

  it('cancels runs whose job did not finish, after a restart', async () => {
    t = await createJobsApp({ keepData: true, stopGraceMs: 50 });
    dataDir = t.dataDir;
    const hold = gate();
    const handler = fakeHandler({
      operation: 'registry',
      execute: async (item, ctx) => {
        await hold.promise;
        return registryResult(item, ctx);
      },
    });
    t.registry.use(handler);
    const watch = await createWatch(t, { includeRegistry: true });
    const job = t.app.get(WatchScheduler).runNow(watch.id);
    await waitFor(() => handler.calls.length > 0, 5000, 'registry call in flight');
    await t.close();
    hold.open();

    t = await createJobsApp({ dataDir, keepData: true });
    const [run] = await runs(t, watch.id);
    expect(run).toMatchObject({ jobId: job.id, status: 'cancelled' });
    expect(run!.note).toContain('interrupted');
    expect(run!.note!.match(/interrupted/g)).toHaveLength(1);
  });

  it('deletes a watch with its events and detaches its running job from it', async () => {
    t = await createJobsApp();
    const app = t;
    const hold = gate();
    const handler = fakeHandler({
      operation: 'registry',
      execute: async (item, ctx) => {
        await hold.promise;
        return registryResult(item, ctx);
      },
    });
    app.registry.use(handler);
    const watch = await createWatch(app, { domains: ['example.com', 'example.net'], includeRegistry: true });
    const job = app.app.get(WatchScheduler).runNow(watch.id);
    await waitFor(() => handler.calls.length > 0, 5000, 'registry call in flight');
    expect(app.events.read(0, { watchId: watch.id }).length).toBeGreaterThan(0);
    const watermark = app.events.deletedThrough();

    await app.api.delete(`/watches/${watch.id}`).expect(200);
    await app.api.get(`/watches/${watch.id}`).expect(404);
    expect(app.events.read(0, { watchId: watch.id }, 100_000)).toEqual([]);
    expect(app.events.deletedThrough()).toBeGreaterThan(watermark);

    hold.open();
    const done = await app.finished(job.id);
    expect(done.watchId).toBeNull();
    // Results of the detached job are still recorded, but nothing refers to the deleted watch.
    const all = app.events.read(0, {}, 100_000);
    expect(all.filter((e) => e.jobId === job.id && e.type === 'result.observed')).toHaveLength(2);
    expect(all.filter((e) => e.watchId === watch.id)).toEqual([]);
    // Only the deletion tombstone may still name the watch; it carries no watch details.
    const tombstones = all.filter((e) => e.type === 'watch.deleted');
    expect(tombstones.map((e) => e.payload)).toEqual([{ watchId: watch.id, deletedAt: expect.any(String) }]);
    expect(JSON.stringify(all.filter((e) => e.type !== 'watch.deleted').map((e) => e.payload))).not.toContain(watch.id);
  });
});
