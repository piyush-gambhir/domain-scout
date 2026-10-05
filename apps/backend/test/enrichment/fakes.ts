import { vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@domain-scout/contracts';
import type { JobItemRecord, OperationContext } from '../../src/jobs/operation.js';
import type { SettingsService } from '../../src/system/settings.service.js';
import type {
  DnsRecord,
  DnsRecordType,
  DnsTransport,
  FetchLike,
  HttpProbe,
  HttpProbeRequest,
  HttpProbeResponse,
  TlsProbe,
  TlsProbeResult,
} from '../../src/enrichment/transports.js';

export const NOW = new Date('2026-10-05T12:00:00.000Z');

export function settings(overrides: { timeoutMs?: number; keepRaw?: boolean; resolver?: Settings['diagnostics']['resolver'] } = {}): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (overrides.timeoutMs !== undefined) s.retries.timeoutMs = overrides.timeoutMs;
  if (overrides.keepRaw !== undefined) s.privacy.keepRawDiagnostics = overrides.keepRaw;
  if (overrides.resolver !== undefined) s.diagnostics.resolver = overrides.resolver;
  return s;
}

export function ctx(options: { settings?: Settings; signal?: AbortSignal } = {}): OperationContext {
  return {
    signal: options.signal ?? new AbortController().signal,
    attempt: 1,
    settings: options.settings ?? settings(),
    now: () => new Date(NOW),
    allowCache: true,
  };
}

export function settingsService(s: Settings = settings()): SettingsService {
  return { get: () => s } as unknown as SettingsService;
}

export function item(
  operation: 'name_check' | 'diagnostic',
  subject: string,
  target: string,
  jobInput: Record<string, unknown> = {},
): JobItemRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    jobId: '00000000-0000-4000-8000-000000000002',
    jobType: operation === 'name_check' ? 'name_check' : 'diagnostics',
    seq: 1,
    subject,
    unicode: subject,
    suffix: operation === 'diagnostic' ? subject.split('.').slice(1).join('.') : null,
    operation,
    target,
    attempts: 0,
    jobInput,
  };
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Fake fetch that routes by URL prefix and records every call; unknown URLs fail the test. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers)) });
    const key = Object.keys(routes)
      .filter((prefix) => url.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`unexpected request to ${url}`);
    return routes[key]!(url, init);
  };
  return { fetch: vi.fn(fn), calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A request that never answers until its signal aborts (for timeout tests). */
export const hang: Route = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  });

/** Fake resolver: record queries per type, and `addresses` for the connection-target lookup. */
export function fakeDns(
  answers: Partial<Record<DnsRecordType, DnsRecord[] | { code: string }>>,
  addresses: string[] | { code: string } = { code: 'ENOTFOUND' },
): DnsTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    servers: () => ['192.0.2.53'],
    async lookup(host) {
      calls.push(`${host} lookup`);
      if (!Array.isArray(addresses)) throw Object.assign(new Error(`getaddrinfo ${addresses.code} ${host}`), { code: addresses.code });
      return addresses;
    },
    async query(name, type) {
      calls.push(`${name} ${type}`);
      const answer = answers[type];
      if (!answer) throw Object.assign(new Error(`query ${type} ENODATA`), { code: 'ENODATA' });
      if (!Array.isArray(answer)) throw Object.assign(new Error(`query ${type} ${answer.code}`), { code: answer.code });
      return answer;
    },
  };
}

export function fakeTls(result: TlsProbeResult | { code: string }): TlsProbe & { calls: string[] } {
  const calls: string[] = [];
  const probe = (async (address: string, port: number, options: { servername: string }) => {
    calls.push(`${address}:${port} sni=${options.servername}`);
    if ('code' in result) throw Object.assign(new Error(`connect ${result.code}`), { code: result.code });
    return result;
  }) as unknown as TlsProbe & { calls: string[] };
  probe.calls = calls;
  return probe;
}

export const noDns: DnsTransport = {
  servers: () => [],
  query: () => Promise.reject(new Error('unexpected DNS query')),
  lookup: () => Promise.reject(new Error('unexpected address lookup')),
};

/** Resolves every connection target to a public documentation-free address (example.com's former A record). */
export const PUBLIC_ADDRESS = '93.184.215.14';
export const publicDns = (addresses: string[] = [PUBLIC_ADDRESS]) => fakeDns({}, addresses);
export const noTls: TlsProbe = () => Promise.reject(new Error('unexpected TLS probe'));
export const noHttp: HttpProbe = () => Promise.reject(new Error('unexpected HTTP probe'));

type HttpAnswer = Partial<HttpProbeResponse> | { code: string } | 'hang';

/** Fake pinned HTTP probe: answers per method and records which address each request was pinned to. */
export function fakeHttp(answer: (request: HttpProbeRequest) => HttpAnswer) {
  const calls: { method: string; host: string; address: string; path: string }[] = [];
  const probe = vi.fn<HttpProbe>(async (request) => {
    calls.push({ method: request.method, host: request.host, address: request.address, path: request.path });
    const result = answer(request);
    if (result === 'hang') {
      return new Promise<HttpProbeResponse>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      });
    }
    if ('code' in result) throw Object.assign(new Error(`request ${result.code}`), { code: result.code });
    return { status: 200, statusText: 'OK', headers: {}, bytesRead: 0, truncated: false, ...result };
  });
  return { http: probe, calls };
}
