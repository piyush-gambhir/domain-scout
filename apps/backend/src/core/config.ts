import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

export interface AppConfig {
  /** Durable per-user application data (SQLite, credentials, artifacts). */
  dataDir: string;
  /** Transient runtime metadata (runtime file, API token, lock). */
  runtimeDir: string;
  host: string;
  port: number;
  /** Origins allowed to send browser requests (the local Next server). */
  webOrigins: string[];
  version: string;
  instanceId: string;
  startedAt: string;
  /** True in tests: no lock, runtime file or signal handlers. */
  embedded: boolean;
  /** Local API token. When absent it is loaded from (or created in) `<runtimeDir>/api-token`. */
  apiToken?: string;
  /** Grace period for in-flight work during a graceful stop (default 5000 ms). */
  stopGraceMs?: number;
  /** Lifetime of browser bootstrap codes (default 60 s). The container launcher prints a longer-lived one. */
  bootstrapTtlMs?: number;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

const require = createRequire(import.meta.url);

export function packageVersion(): string {
  try {
    return (require('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: overrides.dataDir ?? '/tmp/domain-scout-test',
    runtimeDir: overrides.runtimeDir ?? '/tmp/domain-scout-test/run',
    host: '127.0.0.1',
    port: 0,
    webOrigins: ['http://127.0.0.1:3000', 'http://localhost:3000'],
    version: '0.0.0-test',
    instanceId: randomUUID(),
    startedAt: new Date().toISOString(),
    embedded: true,
    // A fixed in-memory token keeps tests from writing token files outside their temp directory.
    apiToken: randomBytes(32).toString('base64url'),
    ...overrides,
  };
}
