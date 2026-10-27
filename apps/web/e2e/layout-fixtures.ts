import type { Page } from '@playwright/test';
import { EARLIER, LATER, NOW, PROVIDERS, SETTINGS, mockApi, ok, paged, provider, uuid } from './mock-api';

/*
 * Large route fixtures for the layout checks: enough rows that every growing list overflows its pane.
 * Shapes follow packages/contracts. Domains are limited to the fixed test set and 24-character labels;
 * provider and shortlist names are fictional and never leave the page.
 */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Deterministic 24-character label for row n. */
export function label24(n: number): string {
  let out = '';
  let x = n * 2654435761 + 12345;
  for (let i = 0; i < 24; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += LETTERS[x % 26];
  }
  return out;
}

const NAMED = [
  ['porkbun', 'Porkbun'],
  ['dynadot', 'Dynadot'],
  ['hostinger', 'Hostinger'],
  ['namecheap', 'Namecheap'],
  ['godaddy', 'GoDaddy'],
  ['cloudflare', 'Cloudflare Registrar'],
  ['spaceship', 'Spaceship'],
  ['namesilo', 'NameSilo'],
  ['namecom', 'Name.com'],
] as const;

/** Nine named registrars plus an 87-entry registry directory, as GET /providers returns them. */
export function providerList() {
  const named = NAMED.map(([id, name]) => provider(id, name, [`api.${id}.provider.invalid`]));
  const directory = Array.from({ length: 87 }, (_, i) => ({
    ...provider(`register-si-fixture-${i + 1}`, `Fixture registrar ${String(i + 1).padStart(2, '0')} d.o.o.`, []),
    kind: 'directory',
    suffixes: ['si'],
  }));
  return [...named, ...directory];
}

function registryObservation(n: number, outcome: string, checkedAt: string) {
  return {
    id: uuid(0x7000 + n),
    domain: 'nic.si',
    unicode: 'nic.si',
    suffix: 'si',
    source: { registryId: 'register-si', protocol: 'rdap', destination: 'https://rdap.register.si/', routing: 'iana_bootstrap' },
    outcome,
    eligibility: { status: 'unknown', source: null, scope: null },
    reason: { code: outcome, message: 'rdap.register.si returned a registration record for nic.si' },
    checkedAt,
    staleAt: LATER,
    freshness: 'fresh',
    reused: false,
    httpStatus: 200,
    retryAt: null,
    matchedName: 'nic.si',
    parserVersion: 'fixture',
    registration: {
      registrar: 'Fixture Registrar',
      createdAt: '2008-10-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
      expiresAt: '2027-10-28T00:00:00.000Z',
      statuses: ['active'],
      nameservers: ['dns1.fixture.invalid', 'dns2.fixture.invalid', 'dns3.fixture.invalid'],
      dnssec: null,
    },
    hasRawDiagnostics: false,
  };
}

function offer(n: number, providerId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(0x7100 + n),
    providerId,
    domain: null,
    suffix: 'si',
    purchasePath: 'new_registration',
    kind: 'published',
    currency: 'USD',
    region: null,
    registration: { amount: '20.38', years: 1 },
    minYears: null,
    renewal: { amount: '17.50', years: 1 },
    transfer: { amount: null, includesYears: null },
    fees: { icann: null, other: [], tax: 'unknown' },
    premium: { status: 'unknown', registration: null, renewal: null },
    promotion: null,
    observedAt: NOW,
    publishedAt: null,
    quoteExpiresAt: null,
    staleAt: LATER,
    freshness: 'fresh',
    source: { label: 'Fixture public pricing', url: null },
    destination: { url: `https://${providerId}.provider.invalid/search?domain=nic.si`, kind: 'search' },
    ...overrides,
  };
}

/** nic.si with every evidence kind and 96 providers (9 named, 87 from the registry directory). */
export function richEvidence() {
  const providers = providerList().map((p) => ({
    providerId: p.id,
    name: p.name,
    kind: p.kind === 'directory' ? 'directory' : 'registrar',
    supportsSuffix: p.kind === 'directory' ? 'yes' : p.id === 'hostinger' ? 'unknown' : 'yes',
    purchaseUrl: p.kind === 'directory' ? `https://${p.id}.provider.invalid/` : `https://${p.id}.provider.invalid/search?domain=nic.si`,
    purchaseKind: p.kind === 'directory' ? 'website' : 'search',
    enabled: true,
    preferred: p.id === 'porkbun',
  }));
  return {
    domain: 'nic.si',
    unicode: 'nic.si',
    suffix: 'si',
    registry: [registryObservation(1, 'registered', NOW), registryObservation(2, 'registered', EARLIER), registryObservation(3, 'rate_limited', EARLIER)],
    confirmations: [
      {
        id: uuid(0x7201),
        providerId: 'dynadot',
        domain: 'nic.si',
        status: 'unavailable',
        premium: false,
        checkedAt: NOW,
        staleAt: LATER,
        freshness: 'fresh',
        destination: 'api.dynadot.provider.invalid',
        reason: { code: 'taken', message: 'Provider reports the name is taken' },
      },
    ],
    offers: [
      offer(1, 'porkbun'),
      offer(2, 'dynadot', {
        kind: 'exact_quote',
        domain: 'nic.si',
        registration: { amount: '1.99', years: 1 },
        renewal: { amount: '45.98', years: 2 },
        fees: { icann: null, other: [], tax: 'unknown' },
        promotion: { description: 'First year sale', requiresTermYears: 2, restrictions: 'New customers only', expiresAt: LATER, eligibilityVerified: false },
        source: { label: 'Fixture quote', url: null },
      }),
      offer(3, 'hostinger', { purchasePath: 'transfer', transfer: { amount: '9.99', includesYears: 1 }, registration: { amount: null, years: 1 } }),
    ],
    nameChecks: [
      {
        id: uuid(0x7301),
        name: 'nic',
        service: 'github',
        namespace: 'users',
        outcome: 'exists',
        destination: 'api.github.com',
        httpStatus: 200,
        checkedAt: NOW,
        staleAt: LATER,
        freshness: 'fresh',
        reason: { code: 'exists', message: 'Account exists' },
        detail: null,
      },
    ],
    diagnostics: [
      {
        id: uuid(0x7401),
        domain: 'nic.si',
        check: 'dns',
        outcome: 'observed',
        destination: 'system resolver',
        checkedAt: NOW,
        staleAt: LATER,
        freshness: 'fresh',
        reason: { code: 'observed', message: 'A records returned' },
        data: { a: ['192.0.2.1'] },
      },
    ],
    listings: [],
    collections: [{ id: uuid(0x7501), name: 'Fixture shortlist', notes: null }],
    providers,
  };
}

/** Rich evidence for any domain name, plus the full provider list. */
export async function mockRichDomain(page: Page) {
  return mockApi(page, {
    'GET /providers': () => paged(providerList()),
    'GET /domains/:name/evidence': (_c, p) => ok({ ...richEvidence(), domain: p.name, unicode: p.name }),
  });
}

/* monitoring */

export const BIG_WATCH = uuid(0xa100);

export async function mockBigMonitoring(page: Page) {
  const watches = Array.from({ length: 16 }, (_, i) => ({
    id: i === 0 ? BIG_WATCH : uuid(0xa100 + i),
    name: i === 0 ? 'Fixture watch with history' : `Fixture watch ${i + 1}`,
    domains: i === 0 ? Array.from({ length: 120 }, (_, n) => `${label24(n)}.com`) : ['example.com', 'google.com'],
    includeRegistry: true,
    providerIds: i % 2 ? ['porkbun'] : [],
    includeCatalogPrices: false,
    intervalMinutes: 1440,
    state: i % 4 === 3 ? 'paused' : 'active',
    destinations: ['rdap.verisign.com', 'api.porkbun.provider.invalid'],
    createdAt: EARLIER,
    updatedAt: EARLIER,
    lastRunAt: EARLIER,
    nextRunAt: i % 4 === 3 ? null : LATER,
    missedRuns: i % 5 === 0 ? 2 : 0,
    lastJobId: uuid(0xa200),
    unreadNotices: i % 3,
    registry: i === 0 ? { outcomes: { registered: 96, no_record: 12, inconclusive: 4, rate_limited: 1 }, unchecked: 7 } : { outcomes: { registered: 1, no_record: 1 }, unchecked: 0 },
  }));
  const notices = Array.from({ length: 40 }, (_, i) => ({
    id: uuid(0xa300 + i),
    watchId: i % 2 ? BIG_WATCH : uuid(0xa101),
    domain: i % 7 === 0 ? '.com' : `${label24(i)}.com`,
    type: i % 7 === 0 ? 'price_changed' : 'availability_changed',
    summary: i % 7 === 0 ? 'Published registration price changed' : 'Registry record no longer returned',
    before:
      i % 7 === 0
        ? { kind: 'offer', id: uuid(0xa400 + i), observedAt: EARLIER, source: 'Porkbun catalog', value: 'USD 10.37' }
        : { kind: 'registry', id: uuid(0xa400 + i), observedAt: EARLIER, source: 'rdap.verisign.com', value: 'registered' },
    after:
      i % 7 === 0
        ? { kind: 'offer', id: uuid(0xa500 + i), observedAt: NOW, source: 'Porkbun catalog', value: 'USD 11.08' }
        : { kind: 'registry', id: uuid(0xa500 + i), observedAt: NOW, source: 'rdap.verisign.com', value: 'no_record' },
    createdAt: NOW,
    readAt: i % 3 ? EARLIER : null,
  }));
  const runs = Array.from({ length: 30 }, (_, i) => ({
    id: uuid(0xa600 + i),
    watchId: BIG_WATCH,
    status: i % 6 === 1 ? 'missed' : i % 6 === 3 ? 'completed_with_errors' : 'completed',
    scheduledFor: EARLIER,
    startedAt: i % 6 === 1 ? null : EARLIER,
    finishedAt: i % 6 === 1 ? null : EARLIER,
    jobId: i % 6 === 1 ? null : uuid(0xa700 + i),
    changes: i % 4,
    failures: i % 6 === 3 ? 1 : 0,
    note: i % 6 === 1 ? 'Backend was stopped' : null,
  }));
  return mockApi(page, {
    'GET /providers': () => paged(PROVIDERS),
    'GET /settings': () => ok(SETTINGS),
    'GET /watches': () => paged(watches),
    'GET /watches/:id': (_c, p) => ok(watches.find((w) => w.id === p.id) ?? watches[0]),
    'GET /watches/:id/runs': () => paged(runs),
    'GET /notices': (c) => {
      let list = notices;
      if (c.search.get('watchId')) list = list.filter((n) => n.watchId === c.search.get('watchId'));
      if (c.search.get('unread') === 'true') list = list.filter((n) => n.readAt === null);
      return paged(list);
    },
  });
}

/* price history */

export async function mockManyPriceSeries(page: Page) {
  const point = (n: number, day: number, registration: string | null) => ({
    offerId: uuid(0xb000 + n),
    observedAt: `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    kind: 'published',
    registration,
    renewal: '11.08',
    transfer: '8.00',
  });
  const series = NAMED.slice(0, 6).map(([id], i) => ({
    key: `${id}|com|new_registration|USD|-|1|0`,
    providerId: id,
    scope: 'com',
    purchasePath: 'new_registration',
    currency: 'USD',
    region: null,
    termYears: 1,
    promotional: false,
    kind: 'published',
    promotion: null,
    points: Array.from({ length: 10 }, (_, d) => point(i * 20 + d, d + 1, (10 + i + (d % 3) * 0.5).toFixed(2))),
    gaps: [],
  }));
  return mockApi(page, {
    'GET /providers': () => paged(PROVIDERS),
    'GET /price-history': () => paged(series),
  });
}
