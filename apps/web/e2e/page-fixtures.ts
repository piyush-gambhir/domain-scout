import type { Page } from '@playwright/test';
import { EARLIER, LATER, NOW, PROVIDERS, SETTINGS, applyPatch, job, mockApi, ok, paged, uuid } from './mock-api';

/*
 * Page-level fixture sets shared by the specs (and handy for visual review). Each installs route
 * handlers on a page and returns the recorded API calls. Names follow the fixed live test set.
 */

/* monitoring */

export const W1 = uuid(0xa1);
export const W2 = uuid(0xa2);

function watch(id: string, overrides: Record<string, unknown>) {
  return {
    id,
    name: 'Watch',
    domains: ['example.com'],
    includeRegistry: true,
    providerIds: [] as string[],
    includeCatalogPrices: false,
    intervalMinutes: 1440,
    state: 'active',
    destinations: [] as string[],
    createdAt: EARLIER,
    updatedAt: EARLIER,
    lastRunAt: EARLIER as string | null,
    nextRunAt: LATER as string | null,
    missedRuns: 0,
    lastJobId: null as string | null,
    unreadNotices: 0,
    ...overrides,
  };
}

function evidence(kind: string, value: string, source: string, observedAt: string, n: number) {
  return { kind, id: uuid(0xe00 + n), observedAt, source, value };
}

export async function mockMonitoring(page: Page) {
  let watches = [
    watch(W1, {
      name: 'Launch names',
      domains: ['example.com', 'google.com'],
      providerIds: ['porkbun'],
      destinations: ['rdap.verisign.com', 'api.porkbun.com'],
      missedRuns: 2,
      unreadNotices: 1,
      lastJobId: uuid(0xb1),
    }),
    watch(W2, { name: 'Slovenian names', domains: ['nic.si'], state: 'paused', nextRunAt: null }),
  ];
  let notices = [
    {
      id: uuid(0xc1),
      watchId: W1,
      domain: 'example.com',
      type: 'availability_changed',
      summary: 'Registry record no longer returned',
      before: evidence('registry', 'registered', 'rdap.verisign.com', EARLIER, 1),
      after: evidence('registry', 'no_record', 'rdap.verisign.com', NOW, 2),
      createdAt: NOW,
      readAt: null as string | null,
    },
    {
      id: uuid(0xc2),
      watchId: W1,
      domain: '.com',
      type: 'price_changed',
      summary: 'Published registration price changed',
      before: evidence('offer', 'USD 10.37', 'Porkbun catalog', EARLIER, 3),
      after: evidence('offer', 'USD 11.08', 'Porkbun catalog', NOW, 4),
      createdAt: EARLIER,
      readAt: EARLIER,
    },
  ];
  const runs = [
    { id: uuid(0xd1), watchId: W1, status: 'catch_up', scheduledFor: NOW, startedAt: NOW, finishedAt: NOW, jobId: uuid(0xb1), changes: 1, failures: 0, note: 'Caught up after a restart' },
    { id: uuid(0xd2), watchId: W1, status: 'missed', scheduledFor: EARLIER, startedAt: null, finishedAt: null, jobId: null, changes: 0, failures: 0, note: 'Backend was stopped' },
    { id: uuid(0xd3), watchId: W1, status: 'completed_with_errors', scheduledFor: EARLIER, startedAt: EARLIER, finishedAt: EARLIER, jobId: uuid(0xb2), changes: 0, failures: 1, note: 'rdap.verisign.com timed out' },
  ];
  const unread = () => notices.filter((n) => n.readAt === null);
  const sync = () => {
    watches = watches.map((w) => ({ ...w, unreadNotices: unread().filter((n) => n.watchId === w.id).length }));
  };

  const calls = await mockApi(page, {
    'GET /providers': () => paged(PROVIDERS),
    'GET /settings': () => ok(SETTINGS),
    'GET /watches': () => paged(watches),
    'GET /watches/:id': (_c, p) => ok(watches.find((w) => w.id === p.id)),
    'POST /watches': (c) => {
      const body = c.body as Record<string, unknown>;
      const created = watch(uuid(0xa9), { ...body, nextRunAt: LATER, lastRunAt: null });
      watches = [...watches, created];
      return { status: 201, json: { contractVersion: '1.0.0', data: created } };
    },
    'PATCH /watches/:id': (c, p) => {
      watches = watches.map((w) => (w.id === p.id ? { ...w, ...(c.body as object) } : w));
      return ok(watches.find((w) => w.id === p.id));
    },
    'POST /watches/:id/pause': (_c, p) => {
      watches = watches.map((w) => (w.id === p.id ? { ...w, state: 'paused', nextRunAt: null } : w));
      return ok(watches.find((w) => w.id === p.id));
    },
    'POST /watches/:id/resume': (_c, p) => {
      watches = watches.map((w) => (w.id === p.id ? { ...w, state: 'active', nextRunAt: LATER } : w));
      return ok(watches.find((w) => w.id === p.id));
    },
    'POST /watches/:id/run': (_c, p) => ({ status: 201, json: { contractVersion: '1.0.0', data: job(uuid(0xb9), { type: 'watch', state: 'queued', watchId: p.id }) } }),
    'GET /jobs/:id': (_c, p) => ok(job(p.id!, { type: 'watch', state: 'completed' })),
    'DELETE /watches/:id': (_c, p) => {
      watches = watches.filter((w) => w.id !== p.id);
      return ok({ ok: true });
    },
    'GET /watches/:id/runs': (_c, p) => paged(runs.filter((r) => r.watchId === p.id)),
    'GET /notices': (c) => {
      let list = notices;
      if (c.search.get('watchId')) list = list.filter((n) => n.watchId === c.search.get('watchId'));
      if (c.search.get('unread') === 'true') list = list.filter((n) => n.readAt === null);
      return paged(list);
    },
    'POST /notices/read': (c) => {
      const body = c.body as { ids?: string[]; all?: boolean; watchId?: string };
      const selected = (n: (typeof notices)[number]) => (body.all || body.ids?.includes(n.id)) && (!body.watchId || n.watchId === body.watchId);
      notices = notices.map((n) => (selected(n) ? { ...n, readAt: n.readAt ?? NOW } : n));
      sync();
      return ok({ ok: true });
    },
  });
  return calls;
}

/* history */

export const DONE = uuid(0x101);
export const INTERRUPTED = uuid(0x102);

function entry(id: string, overrides: Record<string, unknown>) {
  return {
    jobId: id,
    type: 'registry_scan',
    label: null,
    state: 'completed',
    createdAt: EARLIER,
    finishedAt: EARLIER,
    total: 2,
    unresolved: 0,
    extensions: ['com'],
    destinations: [] as string[],
    resumable: false,
    ...overrides,
  };
}

export async function mockHistory(page: Page) {
  let entries = [
    entry(DONE, { label: 'Launch scan' }),
    entry(INTERRUPTED, {
      label: 'Interrupted scan',
      state: 'interrupted',
      finishedAt: null,
      total: 4,
      unresolved: 2,
      resumable: true,
      destinations: ['rdap.verisign.com', 'rdap.arnes.si'],
    }),
    entry(uuid(0x103), { label: 'Quote request', type: 'quote', extensions: [] }),
    ...Array.from({ length: 55 }, (_, i) => entry(uuid(0x200 + i), { label: `Fixture scan ${i + 1}` })),
  ];
  return mockApi(page, {
    'GET /history': (c) => {
      const q = c.search.get('q')?.toLowerCase();
      const type = c.search.get('type');
      const rows = entries.filter((e) => (!q || (e.label ?? '').toLowerCase().includes(q)) && (!type || e.type === type));
      const offset = Number(c.search.get('cursor') ?? 0);
      const limit = Number(c.search.get('limit') ?? 50);
      return paged(rows.slice(offset, offset + limit), offset + limit < rows.length ? String(offset + limit) : null, rows.length);
    },
    'GET /jobs/:id': (_c, p) =>
      ok(job(p.id!, { label: 'Launch scan', input: { extensions: ['com', 'si'], providerIds: [], services: [], checks: [], rows: 2, text: 'example.com\nnic.si' } })),
    'POST /jobs/:id/resume': (_c, p) => ok(job(p.id!, { state: 'running', label: 'Interrupted scan' })),
    'DELETE /jobs/:id': (_c, p) => {
      entries = entries.filter((e) => e.jobId !== p.id);
      return ok({ ok: true });
    },
  });
}

/* compare */

function row(domain: string, providerId: string, overrides: Record<string, unknown> = {}) {
  return {
    domain,
    providerId,
    offerId: uuid(0x400 + providerId.length),
    kind: 'published',
    currency: 'USD',
    nativeCurrency: 'USD',
    fx: null,
    initialCommitment: '10.37',
    initialYears: 1,
    horizonTotal: '32.53',
    prepaidBeyondHorizon: null,
    subtotalOnly: false,
    complete: true,
    missing: [],
    rank: 1,
    freshness: 'fresh',
    observedAt: NOW,
    destination: `https://${providerId}.provider.invalid/search?domain=${domain}`,
    notes: [],
    ...overrides,
  };
}

export async function mockPrices(page: Page) {
  return mockApi(page, {
    'GET /providers': () => paged(PROVIDERS),
    'POST /comparisons': (c) => {
      const body = c.body as { domains: string[]; horizonYears?: number; purchasePath: string };
      return ok({
        horizonYears: body.horizonYears ?? 3,
        purchasePath: body.purchasePath,
        currency: null,
        generatedAt: NOW,
        rows: [
          row('example.com', 'porkbun'),
          row('example.com', 'dynadot', { horizonTotal: '35.10', subtotalOnly: true, complete: false, missing: ['tax'], rank: 2 }),
          row('example.com', 'hostinger', {
            offerId: null,
            kind: null,
            currency: null,
            nativeCurrency: null,
            initialCommitment: null,
            initialYears: null,
            horizonTotal: null,
            subtotalOnly: true,
            complete: false,
            missing: ['registration', 'renewal'],
            rank: null,
            freshness: null,
            observedAt: null,
            notes: ['No price is known from this provider for this purchase path'],
          }),
          row('google.com', 'porkbun', { rank: 1, horizonTotal: '33.00' }),
        ],
        cheapest: [
          { domain: 'example.com', currency: 'USD', providerId: 'porkbun', horizonTotal: '32.53' },
          { domain: 'google.com', currency: 'USD', providerId: 'porkbun', horizonTotal: '33.00' },
        ],
        lowestSubtotal: [{ domain: 'example.com', currency: 'USD', providerId: 'dynadot', horizonTotal: '35.10' }],
        limits: ['Future renewals are estimates based on current renewal prices.'],
      });
    },
    'GET /domains/:name/transfer-options': (_c, p) =>
      paged([
        {
          domain: p.name,
          providerId: 'porkbun',
          transfer: { amount: '9.68', currency: 'USD' },
          includesYears: 1,
          renewal: { amount: '11.08', currency: 'USD' },
          kind: 'published',
          freshness: 'stale',
          observedAt: EARLIER,
          eligibility: { known: ['clientTransferProhibited'], unknown: ['Registration age at least 60 days'] },
          destination: 'https://porkbun.provider.invalid/transfer',
        },
      ]),
    'GET /aftermarket/sources': () =>
      paged([
        { id: 'sedo', name: 'Sedo', supported: true, requiresCredentials: false, apiHosts: ['api.sedo.com'], searchUrlTemplate: null, reason: null },
        {
          id: 'afternic',
          name: 'Afternic',
          supported: false,
          requiresCredentials: false,
          apiHosts: [],
          searchUrlTemplate: 'https://afternic.marketplace.invalid/search?q={domain}',
          reason: 'No public listing API',
        },
      ]),
    'GET /domains/:name/listings': (_c, p) =>
      paged(
        p.name === 'example.com'
          ? [
              {
                id: uuid(0x501),
                domain: 'example.com',
                marketplace: 'Sedo',
                providerId: null,
                status: 'fixed_price',
                price: { amount: '2500.00', currency: 'USD' },
                url: 'https://sedo.marketplace.invalid/example.com',
                observedAt: EARLIER,
                freshness: 'stale',
                source: 'Sedo listing page',
                caveat: 'A listing is not proof of seller authority or final cost.',
              },
            ]
          : [],
      ),
    'POST /aftermarket': () => ({ status: 201, json: { contractVersion: '1.0.0', data: job(uuid(0x5ff), { type: 'aftermarket', state: 'queued' }) } }),
    'GET /jobs/:id': (_c, p) => ok(job(p.id!, { type: 'aftermarket', state: 'completed' })),
  });
}

/* settings */

export async function mockSettings(page: Page) {
  let settings: Record<string, unknown> = structuredClone(SETTINGS);
  return mockApi(page, {
    'GET /settings': () => ok(settings),
    'PATCH /settings': (c) => {
      settings = applyPatch(settings, c.body as Record<string, unknown>);
      return ok(settings);
    },
  });
}

export async function mockPriceHistory(page: Page) {
  return mockApi(page, {
    'GET /providers': () => paged(PROVIDERS),
    'GET /price-history': (c) => {
      if (c.search.get('suffix') === 'si') return paged([]);
      const point = (n: number, observedAt: string, registration: string | null) => ({
        offerId: uuid(0x300 + n),
        observedAt,
        kind: 'published',
        registration,
        renewal: '11.08',
        transfer: '8.00',
      });
      return paged([
        {
          key: 'porkbun|com|new_registration|USD|-|1|0',
          providerId: 'porkbun',
          scope: 'com',
          purchasePath: 'new_registration',
          currency: 'USD',
          region: null,
          termYears: 1,
          promotional: false,
          points: [
            point(1, '2026-09-01T00:00:00.000Z', '10.37'),
            point(2, '2026-09-02T00:00:00.000Z', '10.37'),
            point(3, '2026-09-20T00:00:00.000Z', '11.08'),
            point(4, '2026-09-21T00:00:00.000Z', '11.08'),
            point(5, '2026-09-22T00:00:00.000Z', null),
          ],
          gaps: [{ from: '2026-09-02T00:00:00.000Z', to: '2026-09-20T00:00:00.000Z' }],
        },
        {
          key: 'dynadot|com|renewal|USD|-|1|0',
          providerId: 'dynadot',
          scope: 'com',
          purchasePath: 'renewal',
          currency: 'USD',
          region: null,
          termYears: 1,
          promotional: true,
          points: [point(6, NOW, '9.99')],
          gaps: [],
        },
      ]);
    },
  });
}
