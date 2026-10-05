import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test as NestTest } from '@nestjs/testing';
import request from 'supertest';
import { appOptions, configureApp, createApp } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { FakeClock, type Clock } from '../src/core/clock.js';
import { testConfig, type AppConfig } from '../src/core/config.js';

/** A Nest provider replacement, e.g. a fake transport: `{ provide: RdapTransport, useValue: fake }`. */
export type ProviderOverride =
  | { provide: unknown; useValue: unknown }
  | { provide: unknown; useClass: Type }
  | { provide: unknown; useFactory: (...args: never[]) => unknown; inject?: unknown[] };

export interface TestAppOptions {
  clock?: Clock;
  config?: Partial<AppConfig>;
  overrides?: ProviderOverride[];
  /**
   * Default true: requests without an Authorization or Cookie header are sent with the API token,
   * so feature tests need no auth plumbing. Auth tests pass false to see the real rejections.
   */
  autoAuth?: boolean;
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
/** supertest request builders; paths may omit the /api/v1 prefix. */
export type TestClient = Record<Method, (path: string) => request.Test>;

export interface BrowserSession {
  sessionId: string;
  csrfToken: string;
  expiresAt: string;
  /** Cookie header value carrying ds_session and ds_csrf, as the Next server would set them. */
  cookie: string;
}

export interface TestApp {
  app: NestExpressApplication;
  clock: FakeClock;
  config: AppConfig;
  /** The local API token. */
  token: string;
  /** Requests carrying `Authorization: Bearer <token>`. */
  api: TestClient;
  /** Requests with no credentials, even when autoAuth is on. */
  anon: TestClient;
  /** Opens a browser session through the real bootstrap-code exchange. */
  createSession(): Promise<BrowserSession>;
  /** Listens on an ephemeral loopback port (for streaming tests) and returns the base URL. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

const ANON_HEADER = 'x-test-anonymous';

export function apiPath(path: string): string {
  return path.startsWith('/api/') ? path : `/api/v1${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Boots the full application against a temporary data directory. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'domain-scout-test-'));
  const config = testConfig({ dataDir, runtimeDir: join(dataDir, 'run'), ...options.config });
  const clock = (options.clock as FakeClock) ?? new FakeClock();
  const token = config.apiToken!;

  let app: NestExpressApplication;
  if (options.overrides?.length) {
    const builder = NestTest.createTestingModule({ imports: [AppModule.forRoot({ config, clock })] });
    for (const override of options.overrides) {
      const by = builder.overrideProvider(override.provide);
      if ('useValue' in override) by.useValue(override.useValue);
      else if ('useClass' in override) by.useClass(override.useClass);
      else by.useFactory({ factory: override.useFactory as (...args: unknown[]) => unknown, inject: override.inject as never[] });
    }
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication<NestExpressApplication>(appOptions(config));
    configureApp(app, config);
  } else {
    app = await createApp({ config, clock });
  }

  // Test-only convenience; production code has no bypass. The token is still verified by the guard.
  app.use((req: { headers: Record<string, string | string[] | undefined> }, _res: unknown, next: () => void) => {
    const anonymous = req.headers[ANON_HEADER] !== undefined;
    delete req.headers[ANON_HEADER];
    if (options.autoAuth !== false && !anonymous && !req.headers.authorization && !req.headers.cookie) {
      req.headers.authorization = `Bearer ${token}`;
    }
    next();
  });
  await app.init();

  const server = () => app.getHttpServer();
  const client = (decorate: (test: request.Test) => request.Test): TestClient => ({
    get: (path) => decorate(request(server()).get(apiPath(path))),
    post: (path) => decorate(request(server()).post(apiPath(path))),
    put: (path) => decorate(request(server()).put(apiPath(path))),
    patch: (path) => decorate(request(server()).patch(apiPath(path))),
    delete: (path) => decorate(request(server()).delete(apiPath(path))),
  });
  const api = client((test) => test.set('Authorization', `Bearer ${token}`));
  const anon = client((test) => test.set(ANON_HEADER, '1'));

  return {
    app,
    clock,
    config,
    token,
    api,
    anon,
    async createSession() {
      const code = (await api.post('/auth/bootstrap-codes').expect(201)).body.data.code as string;
      const session = (await anon.post('/auth/session').send({ code }).expect(201)).body.data as Omit<BrowserSession, 'cookie'>;
      return { ...session, cookie: `ds_session=${session.sessionId}; ds_csrf=${session.csrfToken}` };
    },
    async listen() {
      if (!server().listening) await new Promise<void>((resolve) => server().listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server().address() as AddressInfo).port}`;
    },
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
