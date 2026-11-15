import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

export interface AppConfig {

  dataDir: string;

  runtimeDir: string;
  host: string;
  port: number;

  webOrigins: string[];
  version: string;
  instanceId: string;
  startedAt: string;

  embedded: boolean;

  apiToken?: string;

  stopGraceMs?: number;

  bootstrapTtlMs?: number;

  idleTimeoutMs?: number;
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

    apiToken: randomBytes(32).toString('base64url'),
    ...overrides,
  };
}
