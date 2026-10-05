import { Global, Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_PREFIX } from '@domain-scout/contracts';
import { CoreModule } from '../../src/core/core.module.js';
import { FakeClock } from '../../src/core/clock.js';
import { testConfig, type AppConfig } from '../../src/core/config.js';
import { AppExceptionFilter } from '../../src/core/errors.js';

/**
 * Boots CoreModule plus the modules under test, with fakes for ports owned by other modules.
 * Isolated from the full AppModule so these tests do not depend on unrelated modules.
 */
@Global()
@Module({})
class FakePortsModule {
  static forRoot(providers: Provider[]): DynamicModule {
    const tokens = providers.map((p) => (typeof p === 'function' ? p : (p as { provide: unknown }).provide));
    return { module: FakePortsModule, providers, exports: tokens as never[] };
  }
}

export interface ModuleApp {
  app: NestExpressApplication;
  clock: FakeClock;
  config: AppConfig;
  get<T>(token: Type<T> | (abstract new (...args: never[]) => T) | string | symbol): T;
  close(options?: { keepData?: boolean }): Promise<void>;
}

export async function createModuleApp(options: {
  modules: (Type<unknown> | DynamicModule)[];
  providers?: Provider[];
  clock?: FakeClock;
  dataDir?: string;
}): Promise<ModuleApp> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'domain-scout-mod-'));
  const config = testConfig({ dataDir, runtimeDir: join(dataDir, 'run') });
  const clock = options.clock ?? new FakeClock();
  const moduleRef = await Test.createTestingModule({
    imports: [CoreModule.forRoot({ config, clock }), FakePortsModule.forRoot(options.providers ?? []), ...options.modules],
    providers: [{ provide: APP_FILTER, useClass: AppExceptionFilter }],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  app.useBodyParser('json', { limit: '25mb' });
  app.setGlobalPrefix(API_PREFIX.replace(/^\//, ''));
  await app.init();
  return {
    app,
    clock,
    config,
    get: (token) => app.get(token as never),
    async close(closeOptions = {}) {
      await app.close();
      if (!closeOptions.keepData && !options.dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
