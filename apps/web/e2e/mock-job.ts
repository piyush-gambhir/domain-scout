import type { Page, Route } from '@playwright/test';

/*
 * Deterministic fixtures for the results view. Names use the reserved .test TLD and every request
 * is answered by page.route, so nothing reaches the backend or the network.
 * Shapes follow packages/contracts (Job, JobItem, DomainEvidence).
 */

export const JOB_ID = '00000000-0000-4000-8000-00000000a001';
export const TOTAL = 1500;
const OUTCOMES = ['registered', 'no_record', 'registered', 'inconclusive', 'registered', 'rate_limited'] as const;
const CHECKED_AT = '2026-10-05T12:00:00.000Z';
const STALE_AT = '2099-01-01T00:00:00.000Z';

function uuid(n: number) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export function domainAt(index: number) {
  return `n${String(index + 1).padStart(4, '0')}.test`;
}

function observation(index: number) {
  const outcome = OUTCOMES[index % OUTCOMES.length]!;
  return {
    id: uuid(100_000 + index),
    domain: domainAt(index),
    unicode: domainAt(index),
    suffix: 'test',
    source: { registryId: 'fixture-registry', protocol: 'rdap', destination: 'https://rdap.fixture.test/', routing: 'curated' },
    outcome,
    eligibility: { status: 'unknown', source: null, scope: null },
    reason: { code: outcome, message: outcome === 'no_record' ? 'Registry returned no record for this name' : 'Fixture response' },
    checkedAt: CHECKED_AT,
    staleAt: STALE_AT,
    freshness: 'fresh',
    reused: false,
    httpStatus: outcome === 'no_record' ? 404 : 200,
    retryAt: null,
    matchedName: outcome === 'registered' ? domainAt(index) : null,
    parserVersion: 'fixture',
    registration:
      outcome === 'registered'
        ? {
            registrar: 'Fixture Registrar',
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            expiresAt: '2027-01-01T00:00:00.000Z',
            statuses: ['client transfer prohibited'],
            nameservers: ['ns1.fixture.test'],
            dnssec: false,
          }
        : null,
    hasRawDiagnostics: false,
  };
}

export function item(index: number) {
  const registry = observation(index);
  const resolved = registry.outcome === 'registered' || registry.outcome === 'no_record';
  return {
    id: uuid(index + 1),
    jobId: JOB_ID,
    subject: domainAt(index),
    unicode: domainAt(index),
    suffix: 'test',
    operation: 'registry',
    target: null,
    state: 'finished',
    attempts: 1,
    outcome: registry.outcome,
    resolved,
    error: null,
    retryAt: null,
    startedAt: CHECKED_AT,
    finishedAt: CHECKED_AT,
    evidence: { registry, confirmation: null, offers: [], nameCheck: null, diagnostic: null, listing: null },
    bestPrice: registry.outcome === 'no_record' ? { providerId: 'fixture', amount: '10.37', currency: 'USD', kind: 'published', years: 1 } : null,
    collectionIds: index % 50 === 0 ? [uuid(999)] : [],
  };
}

const ITEMS = Array.from({ length: TOTAL }, (_, i) => item(i));

function counts() {
  const outcomes: Record<string, number> = {};
  for (const i of ITEMS) outcomes[i.outcome] = (outcomes[i.outcome] ?? 0) + 1;
  const unresolved = ITEMS.filter((i) => !i.resolved).length;
  return { total: TOTAL, pending: 0, running: 0, finished: TOTAL, interrupted: 0, resolved: TOTAL - unresolved, unresolved, outcomes };
}

export const JOB = {
  id: JOB_ID,
  type: 'registry_scan',
  state: 'completed_with_errors',
  label: 'Fixture scan',
  createdAt: CHECKED_AT,
  startedAt: CHECKED_AT,
  finishedAt: CHECKED_AT,
  updatedAt: CHECKED_AT,
  counters: counts(),
  destinations: ['https://rdap.fixture.test/'],
  input: { extensions: ['test'], providerIds: [], services: [], checks: [], rows: TOTAL, text: null },
  watchId: null,
  parentJobId: null,
  nextRetryAt: null,
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ contractVersion: '1.0.0', ...(body as object) }) });
}

/** Installs API fixtures; returns the list of results query strings requested. */
export async function mockJobApi(page: Page): Promise<string[]> {
  const resultQueries: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1', '');
    if (path === `/jobs/${JOB_ID}`) return json(route, { data: JOB });
    if (path === `/jobs/${JOB_ID}/results`) {
      resultQueries.push(url.search);
      const outcomes = url.searchParams.get('outcomes')?.split(',');
      const q = url.searchParams.get('q');
      let rows = ITEMS.filter((i) => (!outcomes || outcomes.includes(i.outcome)) && (!q || i.subject.includes(q)));
      if (url.searchParams.get('order') === 'desc') rows = [...rows].reverse();
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 200);
      const page = rows.slice(offset, offset + limit);
      return json(route, { data: page, total: rows.length, nextCursor: offset + limit < rows.length ? String(offset + limit) : null });
    }
    if (path.startsWith('/domains/') && path.endsWith('/evidence')) {
      const name = decodeURIComponent(path.split('/')[2]!);
      const index = ITEMS.findIndex((i) => i.subject === name);
      const obs = index >= 0 ? observation(index) : null;
      return json(route, {
        data: {
          domain: name,
          unicode: name,
          suffix: 'test',
          registry: obs ? [obs] : [],
          confirmations: [],
          offers: [],
          nameChecks: [],
          diagnostics: [],
          listings: [],
          collections: [],
          providers: [
            { providerId: 'fixture', name: 'Fixture Registrar', supportsSuffix: 'unknown', purchaseUrl: null, purchaseKind: null, enabled: true, preferred: false },
          ],
        },
      });
    }
    if (path === '/collections') return json(route, { data: [], nextCursor: null, total: 0 });
    if (path === '/providers') return json(route, { data: [], nextCursor: null, total: 0 });
    if (path === '/notices') return json(route, { data: [], nextCursor: null, total: 0 });
    if (path === '/auth/session') return json(route, { data: { sessionId: 'fixture', csrfToken: 'fixture', expiresAt: STALE_AT } });
    if (path === '/events') return route.fulfill({ status: 404, body: '' });
    return json(route, { error: { code: 'not_found', message: `No fixture for ${path}`, requestId: 'fixture', domain: null, source: null, retryable: false, retryAt: null, details: null } }, 404);
  });
  return resultQueries;
}
