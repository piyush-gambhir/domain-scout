import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorResponse, ServiceStopResponse } from '@domain-scout/contracts';
import { FakeClock } from '../../src/core/clock.js';
import { testConfig } from '../../src/core/config.js';
import { ActivityMonitor } from '../../src/runtime/activity.js';
import type { ShutdownCoordinator } from '../../src/runtime/shutdown.js';
import { Database } from '../../src/storage/database.js';
import { createTestApp, type TestApp } from '../helpers.js';

const MINUTE = 60_000;

function monitor(idleTimeoutMs: number, runtimeDir = '/nonexistent-run-dir') {
  const clock = new FakeClock();
  const shutdown = { isStopping: false, stop: vi.fn() };
  shutdown.stop.mockImplementation(() => {
    shutdown.isStopping = true;
    return Promise.resolve();
  });
  const activity = new ActivityMonitor(
    testConfig({ idleTimeoutMs, runtimeDir }),
    clock,
    shutdown as unknown as ShutdownCoordinator,
  );
  return { activity, clock, shutdown };
}

describe('ActivityMonitor', () => {
  it('stops the backend once nothing has kept it busy for the whole timeout', () => {
    const { activity, clock, shutdown } = monitor(10 * MINUTE);
    clock.advance(9 * MINUTE);
    expect(activity.check()).toBe(false);
    clock.advance(MINUTE);
    expect(activity.check()).toBe(true);
    expect(shutdown.stop).toHaveBeenCalledWith('idle');
    // Already stopping: no second stop.
    clock.advance(MINUTE);
    expect(activity.check()).toBe(false);
    expect(shutdown.stop).toHaveBeenCalledTimes(1);
  });

  it('restarts the idle period after a busy probe and never stops with a timeout of 0', () => {
    const { activity, clock, shutdown } = monitor(10 * MINUTE);
    let busy: string | null = '1 unfinished job';
    activity.addProbe('jobs', () => busy);
    clock.advance(30 * MINUTE);
    expect(activity.check()).toBe(false);
    busy = null;
    clock.advance(9 * MINUTE);
    expect(activity.check()).toBe(false);
    clock.advance(MINUTE);
    expect(activity.check()).toBe(true);
    expect(shutdown.stop).toHaveBeenCalledTimes(1);

    const never = monitor(0);
    never.clock.advance(24 * 60 * MINUTE);
    expect(never.activity.check()).toBe(false);
  });

  it('counts open requests and event streams until their response closes', () => {
    const { activity, clock } = monitor(10 * MINUTE);
    const listeners: (() => void)[] = [];
    const res = { once: (_event: string, fn: () => void) => listeners.push(fn) };
    const next = vi.fn();
    activity.middleware()({} as never, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(activity.blockers('idle')).toEqual([
      { name: 'requests', detail: '1 open request or event stream' },
    ]);
    expect(activity.blockers('restart', 1)).toEqual([]);
    clock.advance(20 * MINUTE);
    expect(activity.check()).toBe(false);
    listeners.forEach((fn) => fn());
    expect(activity.blockers('idle')).toEqual([]);
    // Closing the response counts as activity: the idle period starts from there.
    clock.advance(9 * MINUTE);
    expect(activity.check()).toBe(false);
  });

  it('skips restart-safe probes for restarts and treats a failing probe as busy', () => {
    const { activity } = monitor(10 * MINUTE);
    activity.addProbe('watches', () => '2 active watches', { blocksRestart: false });
    const remove = activity.addProbe('broken', () => {
      throw new Error('no table');
    });
    expect(activity.blockers('idle').map((b) => b.name)).toEqual(['watches', 'broken']);
    expect(activity.blockers('restart')).toEqual([
      { name: 'broken', detail: 'check failed: no table' },
    ]);
    remove();
    expect(activity.blockers('restart')).toEqual([]);
  });

  describe('UI server', () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('stays up while the UI server recorded in web.json is alive', () => {
      dir = mkdtempSync(join(tmpdir(), 'ds-activity-'));
      const { activity } = monitor(10 * MINUTE, dir);
      writeFileSync(
        join(dir, 'web.json'),
        JSON.stringify({ url: 'http://127.0.0.1:3000', pid: process.pid }),
      );
      expect(activity.blockers('idle')).toEqual([
        { name: 'ui', detail: 'the UI server at http://127.0.0.1:3000 is running' },
      ]);
      expect(activity.blockers('restart').map((b) => b.name)).toEqual(['ui']);
      // A pid that cannot exist: the server is gone, so it no longer counts.
      writeFileSync(
        join(dir, 'web.json'),
        JSON.stringify({ url: 'http://127.0.0.1:3000', pid: 2 ** 22 + 12345 }),
      );
      expect(activity.blockers('idle')).toEqual([]);
    });
  });
});

describe('backend busy state', () => {
  let t: TestApp;
  afterEach(() => t.close());

  it('reports unfinished jobs, active watches and session-only credentials', async () => {
    t = await createTestApp({ config: { idleTimeoutMs: 10 * MINUTE } });
    const activity = t.app.get(ActivityMonitor);
    expect(activity.blockers('idle')).toEqual([]);

    await t.api
      .post('/watches')
      .send({ name: 'Launch', domains: ['example.com'], intervalMinutes: 1440 })
      .expect(201);
    await t.api
      .put('/providers/porkbun/credentials')
      .send({ values: { apiKey: 'pk1_key', secretApiKey: 'sk1_secret' }, storage: 'session' })
      .expect(200);
    t.app
      .get(Database)
      .run(
        `INSERT INTO jobs (id, type, state, input_json, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', 'registry', 'running', '{}', ?, ?)`,
        [t.clock.iso(), t.clock.iso()],
      );

    expect(activity.blockers('idle')).toEqual([
      { name: 'jobs', detail: '1 unfinished job' },
      { name: 'credentials', detail: 'session-only credentials for porkbun' },
      { name: 'watches', detail: '1 active watch' },
    ]);
    // Watches survive a restart, so only the others refuse one.
    const refused = await t.api.post('/service/stop-unless-busy').send({ instanceId: t.config.instanceId }).expect(409);
    const error = ErrorResponse.parse(refused.body).error;
    expect(error.code).toBe('conflict');
    expect(error.details?.map((d) => d.path)).toEqual(['jobs', 'credentials']);
    expect(t.app.get(ActivityMonitor).blockers('idle').length).toBe(3);
  });

  it('stops on request when nothing but its own request is open, and only the instance the caller verified', async () => {
    t = await createTestApp({ config: { idleTimeoutMs: 10 * MINUTE } });
    await t.api.post('/watches').send({ name: 'Launch', domains: ['example.com'], intervalMinutes: 1440 }).expect(201);
    const other = await t.api.post('/service/stop-unless-busy').send({ instanceId: '00000000-0000-4000-8000-000000000009' }).expect(409);
    expect(ErrorResponse.parse(other.body).error.details?.[0]?.path).toBe('instanceId');
    const res = await t.api.post('/service/stop-unless-busy').send({ instanceId: t.config.instanceId.toUpperCase() }).expect(202);
    expect(ServiceStopResponse.parse(res.body).data.stopping).toBe(true);
  });
});
