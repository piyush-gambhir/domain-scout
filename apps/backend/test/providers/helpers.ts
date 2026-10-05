import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { JobOperation } from '@domain-scout/contracts';
import { FakeClock } from '../../src/core/clock.js';
import type { JobItemRecord, OperationContext } from '../../src/jobs/operation.js';
import { ProviderHttp } from '../../src/providers/adapters/http.js';
import type { AdapterContext } from '../../src/providers/adapters/types.js';
import { CREDENTIAL_ENV } from '../../src/providers/credentials.js';
import { ProviderTransport, TransportError, type ProviderHttpRequest, type ProviderHttpResponse } from '../../src/providers/transport.js';
import { SettingsService } from '../../src/system/settings.service.js';
import { createTestApp, type TestApp } from '../helpers.js';

const FIXTURES = new URL('../fixtures/providers/', import.meta.url);

interface FixtureFile {
  provenance: string;
  response: { status: number; headers: Record<string, string>; json?: unknown; body?: string };
}

/** Loads a provider fixture; `{domain}` placeholders are replaced with the requested name. */
export function fixture(provider: string, name: string, vars: { domain?: string } = {}): ProviderHttpResponse {
  const file = JSON.parse(readFileSync(new URL(`${provider}/${name}.json`, FIXTURES), 'utf8')) as FixtureFile;
  if (!file.provenance) throw new Error(`Fixture ${provider}/${name} has no provenance`);
  const raw = file.response.json !== undefined ? JSON.stringify(file.response.json) : (file.response.body ?? '');
  const body = vars.domain ? raw.split('{domain}').join(vars.domain) : raw;
  return { status: file.response.status, headers: file.response.headers, body };
}

type Responder = ProviderHttpResponse | Error | ((request: ProviderHttpRequest) => ProviderHttpResponse | Error);

/** Records every outbound request and answers from registered fixtures. Unmatched requests fail. */
export class FakeTransport extends ProviderTransport {
  readonly requests: ProviderHttpRequest[] = [];
  private readonly routes: { match: (r: ProviderHttpRequest) => boolean; respond: Responder; once: boolean }[] = [];

  on(match: string | RegExp | ((r: ProviderHttpRequest) => boolean), respond: Responder, options: { once?: boolean } = {}) {
    const test =
      typeof match === 'function' ? match : typeof match === 'string' ? (r: ProviderHttpRequest) => r.url.startsWith(match) : (r: ProviderHttpRequest) => match.test(r.url);
    this.routes.push({ match: test, respond, once: options.once ?? false });
    return this;
  }

  reset() {
    this.requests.length = 0;
    this.routes.length = 0;
  }

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    this.requests.push(request);
    const index = this.routes.findIndex((r) => r.match(request));
    if (index === -1) throw new TransportError('network', `No fixture for ${request.method} ${new URL(request.url).pathname}`);
    const route = this.routes[index]!;
    if (route.once) this.routes.splice(index, 1);
    const result = typeof route.respond === 'function' ? route.respond(request) : route.respond;
    if (result instanceof Error) throw result;
    return result;
  }
}

/** Adapter context over a fake transport, without the Nest app. */
export function adapterContext(transport: FakeTransport, credentials: Record<string, string> = {}, now = new Date('2026-10-05T12:00:00.000Z')): AdapterContext {
  const http = new ProviderHttp(transport, { timeoutMs: 5000, now: () => now, secrets: Object.values(credentials) });
  return { credentials, http, now };
}

export interface ProvidersTestApp extends TestApp {
  transport: FakeTransport;
  env: Record<string, string | undefined>;
}

export async function createProvidersApp(env: Record<string, string | undefined> = {}): Promise<ProvidersTestApp> {
  const transport = new FakeTransport();
  const t = await createTestApp({
    overrides: [
      { provide: ProviderTransport, useValue: transport },
      { provide: CREDENTIAL_ENV, useValue: env },
    ],
  });
  return Object.assign(t, { transport, env });
}

export function jobItem(operation: JobOperation, subject: string, target: string, suffix: string | null = null): JobItemRecord {
  return {
    id: randomUUID(),
    jobId: randomUUID(),
    jobType: operation === 'catalog' ? 'catalog_refresh' : operation === 'provider_check' ? 'provider_check' : (operation as 'quote'),
    seq: 0,
    subject,
    unicode: subject,
    suffix,
    operation,
    target,
    attempts: 0,
    jobInput: {},
  };
}

export function operationContext(t: TestApp, clock: FakeClock = t.clock): OperationContext {
  return {
    signal: new AbortController().signal,
    attempt: 1,
    settings: t.app.get(SettingsService).get(),
    now: () => clock.now(),
    allowCache: true,
  };
}

/** Every string an object contains, for secret-leak assertions. */
export function serialized(value: unknown): string {
  return JSON.stringify(value) ?? '';
}
