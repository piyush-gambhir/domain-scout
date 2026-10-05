import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { DEFAULT_SETTINGS, type Settings } from '@domain-scout/contracts';
import { CoreModule } from '../../src/core/core.module.js';
import { FakeClock } from '../../src/core/clock.js';
import { testConfig } from '../../src/core/config.js';
import type { JobItemRecord, OperationContext } from '../../src/jobs/operation.js';
import { RegistryHttpTransport, type HttpGetRequest, type HttpGetResponse } from '../../src/registry/rdap/http-transport.js';
import { RegistryModule } from '../../src/registry/registry.module.js';
import { WhoisTransport, type WhoisRequest, type WhoisResponse } from '../../src/registry/whois/whois-transport.js';

/** Fake RDAP/bootstrap transport: answers from a function and records every request. */
export class FakeHttp extends RegistryHttpTransport {
  calls: HttpGetRequest[] = [];
  constructor(public respond: (request: HttpGetRequest) => HttpGetResponse | Promise<HttpGetResponse> = () => {
    throw new Error('FakeHttp: unexpected request');
  }) {
    super();
  }
  async get(request: HttpGetRequest): Promise<HttpGetResponse> {
    this.calls.push(request);
    return this.respond(request);
  }
}

export class FakeWhois extends WhoisTransport {
  calls: WhoisRequest[] = [];
  constructor(public respond: (request: WhoisRequest) => WhoisResponse | Promise<WhoisResponse> = () => {
    throw new Error('FakeWhois: unexpected request');
  }) {
    super();
  }
  async query(request: WhoisRequest): Promise<WhoisResponse> {
    this.calls.push(request);
    return this.respond(request);
  }
}

export function http(status: number, body = '', headers: Record<string, string> = {}, url = 'https://fake.test/'): HttpGetResponse {
  return { url, status, headers, body, truncated: false };
}

/** CoreModule + RegistryModule on a temporary SQLite database, with fake transports. */
export async function createRegistryHarness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'domain-scout-registry-'));
  const clock = new FakeClock();
  const fakeHttp = new FakeHttp();
  const fakeWhois = new FakeWhois();
  const moduleRef = await Test.createTestingModule({
    imports: [CoreModule.forRoot({ config: testConfig({ dataDir, runtimeDir: join(dataDir, 'run') }), clock }), RegistryModule],
  })
    .overrideProvider(RegistryHttpTransport)
    .useValue(fakeHttp)
    .overrideProvider(WhoisTransport)
    .useValue(fakeWhois)
    .compile();
  await moduleRef.init();
  return {
    moduleRef,
    clock,
    http: fakeHttp,
    whois: fakeWhois,
    async close() {
      await moduleRef.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function item(subject: string, overrides: Partial<JobItemRecord> = {}): JobItemRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    jobId: '00000000-0000-4000-8000-000000000002',
    jobType: 'registry_scan',
    seq: 1,
    subject,
    unicode: subject,
    suffix: subject.includes('.') ? subject.slice(subject.indexOf('.') + 1) : null,
    operation: 'registry',
    target: '',
    attempts: 0,
    jobInput: {},
    ...overrides,
  };
}

export function context(clock: FakeClock, overrides: Omit<Partial<OperationContext>, 'settings'> & { settings?: Partial<Settings> } = {}): OperationContext {
  const { settings, ...rest } = overrides;
  return {
    signal: new AbortController().signal,
    attempt: 1,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    now: () => clock.now(),
    allowCache: true,
    ...rest,
  };
}

export interface RegistryFixture {
  provenance: { kind: 'captured_live' | 'reconstructed'; capturedAt: string | null; request: string | null; notes: string };
  domain: string;
  suffix: string | null;
  protocol: 'rdap' | 'whois';
  route: string;
  query?: string;
  response:
    | { status: number; headers: Record<string, string>; body: string; truncated: boolean }
    | { text: string; truncated: boolean };
  expected: {
    outcome: string;
    reasonCode: string;
    matchedName: string | null;
    eligibility: string;
    registrar?: string;
    expiresAt?: string;
    dnssec?: boolean | null;
    cooldownSeconds?: number;
    cooldownUntil?: string;
  };
}

const FIXTURE_DIR = new URL('../fixtures/registry/', import.meta.url);

export function loadFixture(file: string): RegistryFixture {
  return JSON.parse(readFileSync(new URL(file, FIXTURE_DIR), 'utf8')) as RegistryFixture;
}
