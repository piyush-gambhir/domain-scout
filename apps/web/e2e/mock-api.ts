import type { Page, Request } from '@playwright/test';

/*
 * Route fixtures for pages whose backend modules are still settling, or whose real calls would
 * touch the network or shared state (watch runs, quotes, coverage refresh, data deletion, service
 * stop). Handlers answer by method and path; anything unhandled falls back to an earlier layer,
 * then to the real local backend. Domain names are limited to example.com, google.com, nic.si, bbc.co.uk and random
 * 24-character labels. Shapes follow packages/contracts.
 */

export const NOW = '2026-10-05T12:00:00.000Z';
export const EARLIER = '2026-10-04T12:00:00.000Z';
export const LATER = '2026-10-06T12:00:00.000Z';
export const GIBBERISH = 'qzvkxmwplrtnbjhdgfcsyaeu';

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

export interface Reply {
  status?: number;
  json: unknown;
}

type Handler = (call: Call, params: Record<string, string>) => Reply | Promise<Reply>;

export const ok = (data: unknown): Reply => ({ json: { contractVersion: '1.0.0', data } });
export const paged = (data: unknown[], nextCursor: string | null = null, total: number | null = data.length): Reply => ({
  json: { contractVersion: '1.0.0', data, nextCursor, total },
});
export const notFound = (message = 'Not found'): Reply => ({
  status: 404,
  json: {
    contractVersion: '1.0.0',
    error: { code: 'not_found', message, requestId: 'fixture', domain: null, source: null, retryable: false, retryAt: null, details: null },
  },
});

function matcher(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/:([A-Za-z]+)/g, '(?<$1>[^/]+)')}$`);
}

function bodyOf(request: Request): unknown {
  try {
    return request.postDataJSON();
  } catch {
    return request.postData();
  }
}

/**
 * Installs handlers keyed as "METHOD /path/:param". Returns the list of every API call the page
 * made (handled or not), so tests can assert that nothing unexpected was requested.
 */
export async function mockApi(page: Page, handlers: Record<string, Handler>): Promise<Call[]> {
  const calls: Call[] = [];
  const compiled = Object.entries(handlers).map(([key, handler]) => {
    const [method, path] = key.split(' ') as [string, string];
    return { method, regex: matcher(path), handler };
  });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const call: Call = { method: request.method(), path, search: url.searchParams, body: bodyOf(request), headers: request.headers() };
    calls.push(call);
    // Event streams stay closed so pages poll fixtures instead of the real stream.
    if (path === '/events') return route.fulfill({ status: 404, body: '' });
    for (const { method, regex, handler } of compiled) {
      if (method !== call.method) continue;
      const match = regex.exec(path);
      if (!match) continue;
      const reply = await handler(call, { ...(match.groups ?? {}) });
      return route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', body: JSON.stringify(reply.json) });
    }
    // Next handler (an earlier mockApi layer), else the real local backend.
    return route.fallback();
  });
  return calls;
}

function capability(level: string, requiresCredentials = false) {
  return { level, requiresCredentials, source: null, verifiedAt: null, notes: null };
}

export function provider(id: string, name: string, apiHosts: string[], options: { exactCheck?: string; quote?: string; transfer?: string } = {}) {
  return {
    id,
    name,
    kind: 'registrar',
    website: `https://${id}.provider.invalid`,
    setupUrl: null,
    suffixes: ['com', 'si'],
    enabled: true,
    preferred: false,
    capabilities: {
      purchaseLink: capability('documented'),
      catalog: capability('fixture_tested'),
      exactCheck: capability(options.exactCheck ?? 'documented'),
      quote: capability(options.quote ?? 'documented'),
      transfer: capability(options.transfer ?? 'documented'),
      aftermarket: capability('unsupported'),
    },
    credentialFields: [],
    credentials: { configured: false, storage: null, storageLocation: null, fields: [], lastTestedAt: null, lastTestResult: null, lastTestMessage: null },
    readiness: 'keyless',
    catalog: null,
    purchaseLink: { template: `https://${id}.provider.invalid/checkout?domain={domain}`, kind: 'search', source: 'fixture', verifiedAt: null },
    apiHosts,
    accountRequirements: [],
    rateLimits: null,
  };
}

export const PROVIDERS = [
  provider('porkbun', 'Porkbun', ['api.porkbun.com']),
  provider('dynadot', 'Dynadot', ['api.dynadot.com']),
  provider('hostinger', 'Hostinger', [], { exactCheck: 'unsupported', quote: 'unsupported' }),
];

export const SETTINGS = {
  concurrency: { global: 16, perSource: 1, minSourceIntervalMs: 1000, maxCooldownWaitSeconds: 300 },
  retries: { maxAttempts: 3, timeoutMs: 15_000 },
  freshness: { registryMinutes: 15, catalogHours: 24, quoteMinutes: 15 },
  monitoring: { defaultIntervalMinutes: 1440 },
  comparison: { horizonYears: 3, currency: null as string | null },
  diagnostics: { resolver: 'system' },
  privacy: { keepRawDiagnostics: false },
  fxRates: [] as unknown[],
  appearance: { theme: 'system' },
  search: { defaultExtensions: ['com', 'io', 'dev', 'app', 'co', 'ai'] },
};

/** Deep merge of a SettingsPatch into settings state. */
export function applyPatch<T extends Record<string, unknown>>(state: T, patch: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...state };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...(state[key] as object), ...(value as object) } : value;
  }
  return next as T;
}

export function job(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'registry_scan',
    state: 'completed',
    label: null,
    createdAt: EARLIER,
    startedAt: EARLIER,
    finishedAt: EARLIER,
    updatedAt: EARLIER,
    counters: { total: 2, pending: 0, running: 0, finished: 2, interrupted: 0, resolved: 2, unresolved: 0, outcomes: {} },
    destinations: [],
    input: { extensions: ['com'], providerIds: [], services: [], checks: [], rows: 2, text: null, format: null, csvColumn: null },
    origin: 'ui',
    watchId: null,
    parentJobId: null,
    nextRetryAt: null,
    ...overrides,
  };
}

/** Published suffix prices as GET /prices returns them: three registrars, cheapest first. */
export function suffixPrices(suffixes: string[], horizonYears = 3) {
  const base: Record<string, [string, string]> = { com: ['10.37', '11.08'], io: ['28.12', '45.00'], dev: ['10.81', '12.98'], app: ['12.98', '14.98'], co: ['8.99', '24.99'], ai: ['69.98', '69.98'], si: ['20.38', '17.50'] };
  const providers: [string, string, number][] = [
    ['porkbun', 'Porkbun', 0],
    ['dynadot', 'Dynadot', 1.25],
    ['hostinger', 'Hostinger', 2.5],
  ];
  const add = (a: string, b: number) => (Number(a) + b).toFixed(2);
  return suffixes.map((suffix) => {
    const [reg, renew] = base[suffix] ?? ['9.50', '12.00'];
    return {
      suffix,
      offers: providers.map(([id, name, extra], i) => {
        const registration = add(reg, extra);
        const renewal = add(renew, extra);
        return {
          providerId: id,
          providerName: name,
          offerId: uuid(0x600 + i * 64 + suffix.length),
          kind: 'published',
          currency: 'USD',
          registration,
          registrationYears: 1,
          renewal,
          renewalYears: 1,
          horizonYears,
          horizonTotal: (Number(registration) + Number(renewal) * (horizonYears - 1)).toFixed(2),
          promotional: false,
          observedAt: NOW,
          freshness: 'fresh',
          purchaseUrlTemplate: `https://${id}.provider.invalid/checkout?domain={domain}`,
          purchaseKind: 'search',
        };
      }),
    };
  });
}

/** Requests that would send names off the machine or start work. */
export const EXTERNAL_OR_RUN = /^\/(jobs|rechecks|quotes|provider-checks|transfers|aftermarket|name-checks|diagnostics)(\/|$)/;

export function startedWork(calls: Call[]): Call[] {
  return calls.filter((c) => c.method === 'POST' && EXTERNAL_OR_RUN.test(c.path) && c.path !== '/aftermarket/sources');
}

/** The page itself never scrolls sideways; wide tables scroll inside their own container. */
export async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

export const PHONE = { width: 375, height: 812 };
