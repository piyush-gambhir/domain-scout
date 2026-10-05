import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ServiceStopResponse } from '@domain-scout/contracts';
import { testConfig } from '../../src/core/config.js';
import { ShutdownCoordinator, type StopContext } from '../../src/runtime/shutdown.js';
import type { Database } from '../../src/storage/database.js';
import { createTestApp, type TestApp } from '../helpers.js';

function coordinator(graceMs: number) {
  const db = { checkpoint: vi.fn() } as unknown as Database & { checkpoint: ReturnType<typeof vi.fn> };
  return { db, shutdown: new ShutdownCoordinator(testConfig({ stopGraceMs: graceMs }), db) };
}

describe('ShutdownCoordinator', () => {
  it('runs hooks once, aborts slow work at the grace deadline, checkpoints, then exits', async () => {
    const { db, shutdown } = coordinator(100);
    const order: string[] = [];
    const fast = vi.fn();
    shutdown.onStopping(fast, 'fast');
    shutdown.onStopping(
      (ctx: StopContext) =>
        new Promise<void>((resolve) =>
          ctx.signal.addEventListener('abort', () => {
            order.push('aborted');
            resolve();
          }),
        ),
      'slow',
    );
    const unregistered = vi.fn();
    shutdown.onStopping(unregistered)();
    shutdown.setExitHandler(async (reason) => {
      order.push(`exit:${reason}`);
    });

    const started = Date.now();
    const first = shutdown.stop('test');
    expect(shutdown.isStopping).toBe(true);
    expect(shutdown.stop('again')).toBe(first);
    await first;
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(fast).toHaveBeenCalledTimes(1);
    expect(fast.mock.calls[0]![0]).toMatchObject({ reason: 'test', graceMs: 100 });
    expect(unregistered).not.toHaveBeenCalled();
    expect(order).toEqual(['aborted', 'exit:test']);
    expect(db.checkpoint).toHaveBeenCalledTimes(1);
  });

  it('bounds hooks that ignore the abort and survives failing hooks', async () => {
    const { shutdown } = coordinator(50);
    const after = vi.fn();
    shutdown.onStopping(() => new Promise<void>(() => undefined), 'stuck');
    shutdown.onStopping(() => {
      throw new Error('boom');
    }, 'failing');
    shutdown.onStopping(after, 'after');
    const started = Date.now();
    await shutdown.stop('test');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(after).toHaveBeenCalled();
  });

  it('runs hooks when the app is closed without an explicit stop', async () => {
    const { shutdown } = coordinator(50);
    const hook = vi.fn();
    shutdown.onStopping(hook);
    await shutdown.onModuleDestroy();
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

describe('POST /service/stop', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ config: { stopGraceMs: 100 } });
  });
  afterAll(() => t.close());

  it('answers 202, then stops without exiting an embedded process and refuses new work', async () => {
    const hook = vi.fn();
    t.app.get(ShutdownCoordinator).onStopping(hook, 'test');
    const res = await t.api.post('/service/stop').expect(202);
    expect(ServiceStopResponse.parse(res.body).data).toEqual({ stopping: true, graceMs: 100 });
    await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(1));
    const refused = await t.api.get('/settings').expect(503);
    expect(refused.body.error).toMatchObject({ code: 'unavailable', retryable: true });
    await t.anon.get('/health').expect(200);
    await t.api.post('/service/stop').expect(202);
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
