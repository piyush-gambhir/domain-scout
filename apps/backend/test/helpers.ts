import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../src/app.factory.js';
import { FakeClock, type Clock } from '../src/core/clock.js';
import { testConfig, type AppConfig } from '../src/core/config.js';

export interface TestApp {
  app: NestExpressApplication;
  clock: FakeClock;
  config: AppConfig;
  close(): Promise<void>;
}

/** Boots the full application against a temporary data directory. */
export async function createTestApp(options: { clock?: Clock; config?: Partial<AppConfig> } = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'domain-scout-test-'));
  const config = testConfig({ dataDir, runtimeDir: join(dataDir, 'run'), ...options.config });
  const clock = (options.clock as FakeClock) ?? new FakeClock();
  const app = await createApp({ config, clock });
  await app.init();
  return {
    app,
    clock,
    config,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
