import type { Page } from '@playwright/test';
import { PROVIDERS, SETTINGS, applyPatch, mockApi, ok, paged, provider, suffixPrices, uuid, type Call } from './mock-api';

/** Times relative to the real clock, so freshness reads the way it would for a person. */
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
export const NOW = minutesAgo(3);
export const EARLIER = minutesAgo(60 * 26);
export const OLD = minutesAgo(180);
const LATER = new Date(Date.now() + 24 * 3600_000).toISOString();
const FRESH_UNTIL = '2099-01-01T00:00:00.000Z';

/*
 * One stateful fixture for the task flows: searches, results, saved lists, watches and history.
 * POST /jobs never reaches the backend (a real search would query registries); every outcome below
 * is invented. Names are 24-character gibberish labels, the fixed test set (example.com, google.com,
 * nic.si, bbc.co.uk) or labels under the reserved .test and .example suffixes. Purchase links point
 * at .invalid hosts.
 */

export const GIB = ['qzvkxmwplrtnbjhdgfcsyaeu', 'xjwqzvlkmpbrtnhgdfcsyuae', 'vbnqzxkwmlpjrtdhgfcsaeyu'] as const;
export const DEFAULT_EXTENSIONS = ['com', 'io', 'dev', 'app', 'co', 'ai'];
/**
 * A small grid search: three gibberish names across the extensions plus two fixed-set domains as
 * typed (rows for example.com and google.com hold only .com). Bare real words are never expanded.
 */
export const SMALL_SEARCH = `${GIB.join(' ')} example.com google.com`;

/** Outcomes the tests rely on; everything else follows a deterministic hash. */
const FIXED: Record<string, string> = {
  'example.com': 'registered',
  'google.com': 'registered',
  'nic.si': 'registered',
  'bbc.co.uk': 'registered',
  // A taken and a couldn't-check gibberish cell, so a small grid shows every state.
  [`${GIB[1]}.io`]: 'registered',
  [`${GIB[2]}.ai`]: 'rate_limited',
};

function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function outcomeOf(domain: string): string {
  if (FIXED[domain]) return FIXED[domain];
  if (GIB.some((g) => domain.startsWith(`${g}.`))) return 'no_record';
  const n = hash(domain) % 10;
  return n < 5 ? 'no_record' : n < 8 ? 'registered' : n === 8 ? 'rate_limited' : 'inconclusive';
}

function observation(domain: string, suffix: string, outcome: string, n: number) {
  return {
    id: uuid(0x10000 + n),
    domain,
    unicode: domain,
    suffix,
    source: { registryId: `fixture-${suffix}`, protocol: 'rdap', destination: `https://rdap.${suffix}.fixture.invalid/`, routing: 'iana_bootstrap' },
    outcome,
    eligibility: { status: 'unknown', source: null, scope: null },
    reason: {
      code: outcome,
      message: outcome === 'no_record' ? 'The registry returned no record' : outcome === 'registered' ? 'The registry returned a registration' : 'The registry asked to slow down',
    },
    checkedAt: NOW,
    staleAt: FRESH_UNTIL,
    freshness: 'fresh',
    reused: false,
    httpStatus: outcome === 'no_record' ? 404 : outcome === 'registered' ? 200 : 429,
    retryAt: null,
    matchedName: outcome === 'registered' ? domain : null,
    parserVersion: 'fixture',
    registration:
      outcome === 'registered'
        ? {
            registrar: 'Fixture Registrar',
            createdAt: '2001-04-02T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2027-08-13T00:00:00.000Z',
            statuses: ['client transfer prohibited'],
            nameservers: ['ns1.fixture.invalid'],
            dnssec: false,
          }
        : null,
    hasRawDiagnostics: false,
  };
}


/** Domains a search of this text checks: bare names across the extensions, full domains as typed. */
export function expand(text: string, extensions: string[]): { domain: string; suffix: string }[] {
  const out: { domain: string; suffix: string }[] = [];
  const seen = new Set<string>();
  for (const token of text.split(/[\s,;]+/).map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    const targets = token.includes('.') ? [token] : extensions.map((e) => `${token}.${e}`);
    for (const domain of targets) {
      if (seen.has(domain)) continue;
      seen.add(domain);
      out.push({ domain, suffix: domain.endsWith('.co.uk') ? 'co.uk' : domain.split('.').slice(1).join('.') });
    }
  }
  return out;
}

const PRICE_BASE: Record<string, number> = { com: 10.37, io: 28.12, dev: 10.81, app: 12.98, co: 8.99, ai: 69.98, si: 20.38, test: 6, example: 7 };

/** The best first-year price (USD) a free result carries; prices vary by name so ordering shows. */
export function priceOf(domain: string, suffix = domain.split('.').slice(1).join('.')): string {
  return ((PRICE_BASE[suffix] ?? 9.5) + (hash(domain) % 7)).toFixed(2);
}

/** The same best price in EUR (an invented rate), so a EUR budget selects different names than USD. */
export const EUR_RATE = 1.25;
export function eurPriceOf(domain: string): string {
  return (Number(priceOf(domain)) * EUR_RATE).toFixed(2);
}

const CSV_HEADERS = new Set(['domain', 'domains', 'name', 'names', 'hostname']);

/**
 * Names a search reads from its input, like the backend: CSV (forced, or detected from a header row)
 * reads one column, by name or the first one; anything else is the text itself.
 */
export function searchText(text: string, format: string | undefined, csvColumn: string | undefined): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = (lines[0] ?? '').split(',').map((h) => h.trim().toLowerCase());
  const csv = format === 'csv' || csvColumn !== undefined || (format !== 'lines' && header.length >= 2 && header.some((h) => CSV_HEADERS.has(h)));
  if (!csv) return text;
  const column = csvColumn ? header.indexOf(csvColumn.trim().toLowerCase()) : 0;
  return lines
    .slice(1)
    .map((line) => line.split(',')[Math.max(column, 0)]?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
}

/** A completed (or running) search with invented results. */
export function buildJob(
  id: string,
  text: string,
  extensions: string[],
  options: { label?: string | null; origin?: string; running?: number; createdAt?: string; outcomeFor?: (domain: string) => string } = {},
) {
  const targets = expand(text, extensions);
  const items = targets.map(({ domain, suffix }, n) => {
    const pending = options.running !== undefined && n >= options.running;
    const outcome = pending ? null : (options.outcomeFor ?? outcomeOf)(domain);
    const free = outcome === 'no_record';
    // Prices vary by label so "cheapest first" is visible in long lists.
    const amount = priceOf(domain, suffix);
    return {
      id: uuid(0x20000 + hash(id) % 1000 * 4096 + n),
      jobId: id,
      subject: domain,
      unicode: domain,
      suffix,
      operation: 'registry',
      target: null,
      source: `registry:fixture-${suffix}`,
      state: pending ? 'pending' : 'finished',
      attempts: pending ? 0 : 1,
      outcome: outcome as string | null,
      resolved: outcome === 'registered' || outcome === 'no_record',
      error: null,
      retryAt: null,
      startedAt: pending ? null : NOW,
      finishedAt: pending ? null : NOW,
      evidence: { registry: outcome ? observation(domain, suffix, outcome, n) : null, confirmation: null, offers: [] as unknown[], nameCheck: null, diagnostic: null, listing: null },
      bestPrice: free
        ? { providerId: 'porkbun', amount, currency: 'USD', kind: 'published', years: 1, offerId: uuid(0x30000 + n), source: 'Porkbun pricing', observedAt: NOW, freshness: 'fresh' }
        : null,
      collectionIds: [] as string[],
    };
  });
  const outcomes: Record<string, number> = {};
  for (const item of items) if (item.outcome) outcomes[item.outcome] = (outcomes[item.outcome] ?? 0) + 1;
  const finished = items.filter((i) => i.state === 'finished').length;
  const unresolved = items.filter((i) => i.state === 'finished' && !i.resolved).length;
  const running = options.running !== undefined && finished < items.length;
  return {
    job: {
      id,
      type: 'registry_scan' as string,
      state: running ? 'running' : unresolved ? 'completed_with_errors' : 'completed',
      label: (options.label === undefined ? null : options.label) as string | null,
      createdAt: options.createdAt ?? NOW,
      startedAt: NOW,
      finishedAt: running ? null : NOW,
      updatedAt: NOW,
      counters: { total: items.length, pending: items.length - finished, running: 0, finished, interrupted: 0, resolved: finished - unresolved, unresolved, outcomes },
      destinations: ['rdap.fixture.invalid'],
      input: { extensions, providerIds: [], services: [], checks: [], rows: text.split('\n').length, text, format: 'auto', csvColumn: null },
      origin: (options.origin ?? 'ui') as string,
      watchId: null,
      parentJobId: null,
      nextRetryAt: null,
    },
    items,
  };
}

export type FixtureJob = ReturnType<typeof buildJob>;
type Item = FixtureJob['items'][number];

/** GET /jobs/:id/results semantics: filters, price sort with unknown last, cursor paging. */
export function queryItems(all: Item[], search: URLSearchParams) {
  const list = (key: string) => search.get(key)?.split(',').filter(Boolean);
  const outcomes = list('outcomes');
  const states = list('states');
  const suffixes = list('suffixes');
  const q = search.get('q');
  const maxPrice = search.get('maxPrice');
  const maxLength = Number(search.get('maxLength') ?? 0);
  // Like the backend, best prices (and the price cap) are in the requested currency.
  const currency = search.get('priceCurrency') ?? 'USD';
  const priced = currency === 'EUR' ? all.map((i) => (i.bestPrice ? { ...i, bestPrice: { ...i.bestPrice, currency: 'EUR', amount: (Number(i.bestPrice.amount) * EUR_RATE).toFixed(2) } } : i)) : all;
  let rows = priced.filter(
    (i) =>
      (!outcomes || (i.outcome !== null && outcomes.includes(i.outcome))) &&
      (!states || states.includes(i.state)) &&
      (!suffixes || suffixes.includes(i.suffix)) &&
      (!q || i.subject.includes(q)) &&
      (!maxPrice || (i.bestPrice !== null && Number(i.bestPrice.amount) <= Number(maxPrice))) &&
      (!maxLength || i.subject.length - i.suffix.length - 1 <= maxLength),
  );
  if (search.get('sort') === 'price') rows = [...rows].sort((a, b) => (a.bestPrice ? Number(a.bestPrice.amount) : Infinity) - (b.bestPrice ? Number(b.bestPrice.amount) : Infinity));
  if (search.get('order') === 'desc') rows = [...rows].reverse();
  const offset = Number(search.get('cursor') ?? 0);
  const limit = Number(search.get('limit') ?? 200);
  return paged(rows.slice(offset, offset + limit), offset + limit < rows.length ? String(offset + limit) : null, rows.length);
}

/** Nine registrars with links plus a registry's own registrar list, as GET /providers returns them. */
export function providerFixtures() {
  const directory = Array.from({ length: 12 }, (_, i) => ({
    ...provider(`registry-dir-${i + 1}`, `Fixture registrar ${String(i + 1).padStart(2, '0')}`, []),
    kind: 'directory',
    suffixes: ['si', 'dev', 'app'],
    purchaseLink: { template: `https://dir-${i + 1}.provider.invalid/`, kind: 'website', source: 'fixture', verifiedAt: null },
  }));
  const linkOnly = { ...provider('namecheap', 'Namecheap', []), suffixes: null, capabilities: { ...PROVIDERS[0]!.capabilities } };
  return [...PROVIDERS, linkOnly, ...directory];
}

export interface AppState {
  jobs: Map<string, FixtureJob>;
  collections: { id: string; name: string; notes: string | null; entryCount: number; createdAt: string; updatedAt: string }[];
  entries: Map<string, string[]>;
  notes: Map<string, string | null>;
  watches: Record<string, unknown>[];
  settings: Record<string, unknown>;
}

export interface AppOptions {
  /** Searches that exist before the page opens. */
  jobs?: FixtureJob[];
  /** Saved lists: name and domains. */
  lists?: { name: string; domains: string[] }[];
  watches?: Record<string, unknown>[];
  notices?: Record<string, unknown>[];
  /** Registry evidence age for saved names, so Saved can show older checks. */
  staleSaved?: string[];
  /** New searches start running with this many items finished. */
  running?: number;
  /**
   * New searches answer for this text instead of the posted one, for searches whose names are not in
   * the allowed fixture set (e.g. picked name ideas). The job still records the posted input.
   */
  answerWith?: string;
}

/**
 * Installs the stateful fixture. Returns the recorded calls and the state, so tests can assert what
 * was sent and seed more. Unhandled requests fall through to the real local backend.
 */
export async function mockApp(page: Page, options: AppOptions = {}): Promise<{ calls: Call[]; state: AppState }> {
  const state: AppState = {
    jobs: new Map((options.jobs ?? []).map((j) => [j.job.id, j])),
    collections: [],
    entries: new Map(),
    notes: new Map(),
    watches: options.watches ?? [],
    settings: structuredClone(SETTINGS),
  };
  for (const [index, list] of (options.lists ?? []).entries()) {
    const id = uuid(0xc000 + index);
    state.collections.push({ id, name: list.name, notes: null, entryCount: list.domains.length, createdAt: EARLIER, updatedAt: EARLIER });
    state.entries.set(id, [...list.domains]);
  }
  let notices = options.notices ?? [];
  /** Newest outcome per domain after rechecks; everything else keeps its invented outcome. */
  const latest = new Map<string, string>();
  const current = (domain: string) => latest.get(domain) ?? outcomeOf(domain);
  let nextJob = 1;
  const sync = () => {
    for (const c of state.collections) c.entryCount = state.entries.get(c.id)?.length ?? 0;
    // Result rows report which lists hold them.
    for (const { items } of state.jobs.values()) {
      for (const item of items) item.collectionIds = state.collections.filter((c) => state.entries.get(c.id)?.includes(item.subject)).map((c) => c.id);
    }
  };
  sync();
  const stale = new Set(options.staleSaved ?? []);
  const entry = (collectionId: string, domain: string, n: number) => {
    const suffix = domain.split('.').slice(1).join('.');
    const outcome = current(domain);
    const obs = observation(domain, suffix, outcome, 0x900 + n);
    return {
      id: uuid(0xd000 + n),
      collectionId,
      domain,
      unicode: domain,
      notes: state.notes.get(domain) ?? null,
      addedAt: EARLIER,
      registry: stale.has(domain) && !latest.has(domain) ? { ...obs, checkedAt: OLD, staleAt: minutesAgo(165), freshness: 'stale' } : obs,
      confirmations: [],
      offers: [],
    };
  };

  const calls = await mockApi(page, {
    'GET /settings': () => ok(state.settings),
    'PATCH /settings': (c) => {
      state.settings = applyPatch(state.settings, c.body as Record<string, unknown>);
      return ok(state.settings);
    },
    'GET /providers': () => paged(providerFixtures()),
    'GET /prices': (c) => ok(suffixPrices((c.search.get('suffixes') ?? '').split(',').filter(Boolean), Number(c.search.get('horizonYears') ?? 3))),
    'POST /jobs': (c) => {
      const body = c.body as { label?: string; input: { text: string; extensions: string[]; format?: string; csvColumn?: string } };
      const id = uuid(0xe0000 + nextJob++);
      const names = options.answerWith ?? searchText(body.input.text, body.input.format, body.input.csvColumn);
      const built = buildJob(id, names, body.input.extensions, { label: body.label ?? null, running: options.running });
      // The job keeps the input as posted, so the results bar restores it the way it was read.
      Object.assign(built.job.input, { text: body.input.text, format: body.input.format ?? 'auto', csvColumn: body.input.csvColumn ?? null, rows: body.input.text.split('\n').length });
      state.jobs.set(id, built);
      sync();
      return { status: 201, json: { contractVersion: '1.0.0', data: { ...built.job, input: { ...built.job.input, text: null } } } };
    },
    'GET /jobs': (c) => {
      const origins = c.search.get('origins')?.split(',');
      const jobs = [...state.jobs.values()].map((j) => ({ ...j.job, input: { ...j.job.input, text: null } })).filter((j) => !origins || origins.includes(j.origin));
      return paged(jobs);
    },
    'GET /jobs/:id': (_c, p) => {
      const job = state.jobs.get(p.id!);
      return job ? ok(job.job) : { status: 404, json: { contractVersion: '1.0.0', error: { code: 'not_found', message: 'No such job', requestId: 'f', domain: null, source: null, retryable: false, retryAt: null, details: null } } };
    },
    'GET /jobs/:id/results': (c, p) => queryItems(state.jobs.get(p.id!)?.items ?? [], c.search),
    'POST /rechecks': (c) => {
      const body = c.body as { domains: string[]; label?: string };
      const id = uuid(0xf0000 + nextJob++);
      // A recheck answers: every name rechecked is found unregistered this time, and that becomes the
      // latest evidence everywhere (counters, domain evidence, saved entries).
      for (const domain of body.domains) latest.set(domain, 'no_record');
      const built = buildJob(id, body.domains.join('\n'), [], { label: body.label ?? null, outcomeFor: current });
      state.jobs.set(id, built);
      return { status: 201, json: { contractVersion: '1.0.0', data: built.job } };
    },
    'GET /history': (c) => {
      const origins = c.search.get('origins')?.split(',');
      const type = c.search.get('type');
      const q = c.search.get('q')?.toLowerCase();
      const rows = [...state.jobs.values()]
        .map(({ job }) => job)
        .filter((j) => (!origins || origins.includes(j.origin)) && (!type || j.type === type) && (!q || String(j.label ?? '').toLowerCase().includes(q)))
        .map((j) => ({
          jobId: j.id,
          type: j.type,
          origin: j.origin,
          label: j.label,
          state: j.state,
          createdAt: j.createdAt,
          finishedAt: j.finishedAt,
          total: j.counters.total,
          finished: j.counters.finished,
          unresolved: j.counters.unresolved,
          outcomes: j.counters.outcomes,
          extensions: j.input.extensions,
          destinations: j.destinations,
          resumable: j.state === 'interrupted',
        }));
      const limit = Number(c.search.get('limit') ?? 50);
      return paged(rows.slice(0, limit), null, rows.length);
    },
    'DELETE /jobs/:id': (_c, p) => {
      state.jobs.delete(p.id!);
      return ok({ ok: true });
    },
    'GET /collections': () => paged(state.collections),
    'POST /collections': (c) => {
      const body = c.body as { name: string };
      const created = { id: uuid(0xc100 + state.collections.length), name: body.name, notes: null, entryCount: 0, createdAt: NOW, updatedAt: NOW };
      state.collections.push(created);
      state.entries.set(created.id, []);
      return { status: 201, json: { contractVersion: '1.0.0', data: created } };
    },
    'GET /collections/:id': (_c, p) => ok(state.collections.find((c) => c.id === p.id)),
    'PATCH /collections/:id': (c, p) => {
      const target = state.collections.find((x) => x.id === p.id)!;
      Object.assign(target, c.body as object);
      return ok(target);
    },
    'DELETE /collections/:id': (_c, p) => {
      state.collections = state.collections.filter((c) => c.id !== p.id);
      return ok({ ok: true });
    },
    'GET /collections/:id/entries': (c, p) => {
      const all = state.entries.get(p.id!) ?? [];
      const offset = Number(c.search.get('cursor') ?? 0);
      const limit = Number(c.search.get('limit') ?? 100);
      const page = all.slice(offset, offset + limit).map((d, n) => entry(p.id!, d, offset + n));
      return paged(page, offset + limit < all.length ? String(offset + limit) : null, all.length);
    },
    'POST /collections/:id/entries': (c, p) => {
      const domains = (c.body as { domains: string[] }).domains;
      const list = state.entries.get(p.id!) ?? [];
      const added = domains.filter((d) => !list.includes(d));
      state.entries.set(p.id!, [...list, ...added]);
      sync();
      return ok({ added: added.length, existing: domains.length - added.length, rejected: [] });
    },
    'POST /collections/:id/entries/remove': (c, p) => {
      const domains = (c.body as { domains: string[] }).domains;
      state.entries.set(p.id!, (state.entries.get(p.id!) ?? []).filter((d) => !domains.includes(d)));
      sync();
      return ok({ domains });
    },
    'PATCH /collections/:id/entries/:domain': (c, p) => {
      state.notes.set(decodeURIComponent(p.domain!), (c.body as { notes: string | null }).notes);
      return ok({ ok: true });
    },
    'GET /criteria': () => paged([]),
    'GET /watches': () => paged(state.watches),
    'GET /watches/:id': (_c, p) => ok(state.watches.find((w) => w.id === p.id)),
    'POST /watches': (c) => {
      const body = c.body as { name: string; domains: string[] };
      const created = {
        id: uuid(0xa900 + state.watches.length),
        name: body.name,
        domains: body.domains,
        includeRegistry: true,
        providerIds: [],
        includeCatalogPrices: false,
        intervalMinutes: 1440,
        state: 'active',
        destinations: ['rdap.fixture.invalid'],
        createdAt: NOW,
        updatedAt: NOW,
        lastRunAt: null,
        nextRunAt: LATER,
        missedRuns: 0,
        lastJobId: null,
        unreadNotices: 0,
        registry: { outcomes: {}, unchecked: body.domains.length },
        ...(c.body as object),
      };
      state.watches = [...state.watches, created];
      return { status: 201, json: { contractVersion: '1.0.0', data: created } };
    },
    'GET /notices': (c) => {
      let list = notices as { watchId: string; readAt: string | null }[];
      if (c.search.get('watchId')) list = list.filter((n) => n.watchId === c.search.get('watchId'));
      if (c.search.get('unread') === 'true') list = list.filter((n) => n.readAt === null);
      return paged(list);
    },
    'POST /notices/read': (c) => {
      const body = c.body as { ids?: string[]; all?: boolean; watchId?: string };
      notices = (notices as { id: string; watchId: string; readAt: string | null }[]).map((n) =>
        (body.all || body.ids?.includes(n.id)) && (!body.watchId || n.watchId === body.watchId) ? { ...n, readAt: n.readAt ?? NOW } : n,
      );
      state.watches = state.watches.map((w) => ({ ...w, unreadNotices: (notices as { watchId: string; readAt: string | null }[]).filter((n) => n.watchId === w.id && !n.readAt).length }));
      return ok({ ok: true });
    },
    'GET /domains/:name/evidence': (_c, p) => {
      const domain = decodeURIComponent(p.name!);
      const suffix = domain.endsWith('.co.uk') ? 'co.uk' : domain.split('.').slice(1).join('.');
      const outcome = current(domain);
      return ok({
        domain,
        unicode: domain,
        suffix,
        registry: [observation(domain, suffix, outcome, 0x500)],
        confirmations: [],
        offers: [],
        nameChecks: [],
        diagnostics: [],
        listings: [],
        collections: state.collections.filter((c) => state.entries.get(c.id)?.includes(domain)).map((c) => ({ id: c.id, name: c.name, notes: null })),
        providers: [],
      });
    },
    'GET /domains/:name/offers': () => paged([]),
    'GET /domains/:name/transfer-options': () => paged([]),
    'GET /domains/:name/listings': () => paged([]),
    'GET /aftermarket/sources': () => paged([]),
    'GET /price-history': () => paged([]),
    'POST /comparisons': (c) => {
      const body = c.body as { domains: string[]; horizonYears?: number; purchasePath: string };
      const horizon = body.horizonYears ?? 3;
      const domain = body.domains[0]!;
      const suffix = domain.split('.').slice(1).join('.');
      const prices = suffixPrices([suffix], horizon)[0]!.offers;
      const rows = prices.map((o, i) => ({
        domain,
        providerId: o.providerId,
        offerId: o.offerId,
        kind: 'published',
        currency: 'USD',
        nativeCurrency: 'USD',
        fx: null,
        initialCommitment: o.registration,
        initialYears: 1,
        horizonTotal: o.horizonTotal,
        prepaidBeyondHorizon: null,
        subtotalOnly: i > 0,
        complete: i === 0,
        missing: i > 0 ? ['tax'] : [],
        rank: i + 1,
        freshness: 'fresh',
        observedAt: NOW,
        destination: o.purchaseUrlTemplate.replace('{domain}', domain),
        notes: [],
      }));
      return ok({
        horizonYears: horizon,
        purchasePath: body.purchasePath,
        currency: null,
        generatedAt: NOW,
        rows,
        cheapest: [{ domain, currency: 'USD', providerId: rows[0]!.providerId, horizonTotal: rows[0]!.horizonTotal }],
        lowestSubtotal: [],
        limits: ['Future renewals are estimates based on current renewal prices.'],
      });
    },
  });
  return { calls, state };
}
