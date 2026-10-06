import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, RegistryObservation } from '@domain-scout/contracts';
import type { ObservationWrite } from '../../src/storage/evidence.js';
import { loadRegistryData, type PublishedLimit } from '../../src/registry/data.js';
import { InputPreviewService } from '../../src/registry/input/input-preview.service.js';
import { MAX_PACING_WAIT_MS, PublishedLimits } from '../../src/registry/published-limits.js';
import { RegistryOperationHandler } from '../../src/registry/registry.handler.js';
import { RoutesService } from '../../src/registry/routes.service.js';
import { context, createRegistryHarness, item, loadFixture } from './harness.js';

type Harness = Awaited<ReturnType<typeof createRegistryHarness>>;

const data = loadRegistryData();
const bundledBootstrap = new Set(data.bootstrap.bootstrap.services.flatMap(([tlds]) => tlds));

let h: Harness;
let routes: RoutesService;
let handler: RegistryOperationHandler;
let inputs: InputPreviewService;

beforeEach(async () => {
  h = await createRegistryHarness();
  routes = h.moduleRef.get(RoutesService);
  handler = h.moduleRef.get(RegistryOperationHandler);
  inputs = h.moduleRef.get(InputPreviewService);
});
afterEach(() => h.close());

function observation(result: { evidence: unknown[] }) {
  expect(result.evidence).toHaveLength(1);
  return (result.evidence[0] as { row: ObservationWrite }).row;
}

describe('curated routes', () => {
  it('routes registry-published RDAP services that the IANA bootstrap lacks', () => {
    expect(data.curatedRdap.routes.map((route) => route.tld)).toEqual(['ch', 'li', 'co']);
    for (const spec of data.curatedRdap.routes) {
      const host = new URL(spec.baseUrl).host;
      expect(bundledBootstrap.has(spec.tld), spec.tld).toBe(false);
      expect(routes.route(spec.tld)).toMatchObject({ protocol: 'rdap', routing: 'curated', endpoint: spec.baseUrl, host, registryId: spec.registryId });
      expect(routes.isVerifiedRdapHost(host), host).toBe(true);
      expect(routes.registryIdForHost(host), host).toBe(spec.registryId);
    }
  });

  it('keeps every RDAP and WHOIS host of one operator on one registryId', () => {
    for (const operator of data.operators.registries) {
      for (const host of [...operator.rdapHosts, ...operator.whoisHosts]) expect(routes.registryIdForHost(host), host).toBe(operator.id);
    }
    for (const spec of data.whois.routes) expect(routes.registryIdForHost(spec.host), spec.host).toBe(spec.registryId);
    const id = (suffix: string) => routes.route(suffix)?.registryId;
    expect([id('ch'), id('li')]).toEqual(['switch', 'switch']);
    expect([id('io'), id('sh'), id('vc'), id('me')]).toEqual(['identity-digital', 'identity-digital', 'identity-digital', 'identity-digital']);
    expect([id('la'), id('gl'), routes.registryIdForHost('rdap.centralnic.com')]).toEqual(['centralnic', 'centralnic', 'centralnic']);
    expect([id('gg'), id('je')]).toEqual(['channel-isles', 'channel-isles']);
    expect([id('co.za'), id('org.za'), id('net.za'), id('web.za')]).toEqual(['zarc', 'zarc', 'zarc', 'zarc']);
    expect([handler.sourceKey(item('acme.ch')), handler.sourceKey(item('acme.li'))]).toEqual(['registry:switch', 'registry:switch']);
  });

  it('gives every curated WHOIS classifier registered and no_record fixtures', () => {
    const parserByRoute = new Map(data.whois.routes.map((route) => [`${route.host}:${route.port}`, route.parser]));
    const outcomes = new Map<string, Set<string>>();
    for (const fixture of data.fixtures.fixtures.filter((entry) => entry.protocol === 'whois')) {
      const parser = parserByRoute.get(loadFixture(fixture.file).route)!;
      outcomes.set(parser, (outcomes.get(parser) ?? new Set()).add(fixture.expected));
    }
    for (const parser of new Set(data.whois.routes.map((route) => route.parser))) {
      expect([parser, outcomes.get(parser)?.has('registered'), outcomes.get(parser)?.has('no_record')]).toEqual([parser, true, true]);
    }
  });

  it('records sources and dates for every curated decision', () => {
    for (const spec of data.curatedRdap.routes) expect([spec.tld, spec.source.startsWith('https://'), spec.verifiedAt]).toEqual([spec.tld, true, expect.stringMatching(/^2026-10-05T/)]);
    for (const spec of data.whois.routes) {
      expect(spec.source, spec.tld).toMatch(/^https:\/\//);
      expect(spec.verifiedAt, spec.tld).toMatch(/^2026-10-05T/);
      if (!['de', 'jp', 'cn', 'eu'].includes(spec.tld)) expect(spec.formatSources?.length, spec.tld).toBeGreaterThan(0);
    }
    for (const entry of data.whois.withoutClassifier) expect([entry.tld, entry.checkedAt]).toEqual([entry.tld, expect.stringMatching(/^2026-10-05T/)]);
  });
});

describe('multi-label registration boundaries', () => {
  const routed = (name: string) => {
    const domain = inputs.normalize(name);
    return domain ? [domain.suffix, routes.route(domain.suffix)?.endpoint ?? null] : null;
  };

  it('routes second-level registrations through the registry that runs them', () => {
    expect(routed('acme.com.mx')).toEqual(['com.mx', 'whois.mx:43']);
    expect(routed('acme.org.il')).toEqual(['org.il', 'whois.isoc.org.il:43']);
    expect(routed('acme.co.il')).toEqual(['co.il', 'whois.isoc.org.il:43']);
    expect(routed('acme.com.hk')).toEqual(['com.hk', 'whois.hkirc.hk:43']);
    expect(routed('acme.co.nz')).toEqual(['co.nz', 'whois.irs.net.nz:43']);
    expect(routed('acme.com.tr')).toEqual(['com.tr', 'whois.trabis.gov.tr:43']);
    expect(routed('acme.co.za')).toEqual(['co.za', 'coza-whois.registry.net.za:43']);
    expect(routed('acme.web.za')).toEqual(['web.za', 'web-whois.registry.net.za:43']);
    expect(routed('acme.com.co')).toEqual(['com.co', 'https://rdap.registry.co/co/']);
  });

  it('leaves zones the registry does not (verifiably) run unrouted', () => {
    for (const name of ['acme.ac.za', 'acme.gov.za', 'acme.gov.ie', 'acme.ny.us', 'acme.k12.ny.us', 'acme.org.se', 'acme.gov.co', 'acme.ac.rs', 'acme.gov.lv', 'acme.com.ws', 'acme.gv.at', 'acme.idf.il']) {
      expect([name, routed(name)?.[1]]).toEqual([name, null]);
    }
    expect(routed('acme.za')).toEqual(['za', null]);
  });

  it('rejects private third-level zones and host names instead of querying the TLD registry', () => {
    expect(inputs.normalize('acme.com.ru')).toBeNull();
    expect(inputs.normalize('acme.msk.ru')).toBeNull();
    expect(inputs.normalize('www.acme.com.mx')).toBeNull();
    expect(inputs.normalize('acme.sch.gg')).toBeNull();
  });

  it('answers unrouted zones locally with the reason, without any query', async () => {
    const result = await handler.execute(item('acme.gov.ie'), context(h.clock));
    expect([result.outcome, result.resolved, result.retryable]).toEqual(['unsupported', false, false]);
    expect(result.error?.message).toContain('does not cover the .gov.ie zone');
    expect(handler.sourceKey(item('acme.gov.ie'))).toBeNull();
    expect([h.http.calls.length, h.whois.calls.length]).toEqual([0, 0]);
  });
});

describe('querying curated routes', () => {
  it('sends curated RDAP queries to the registry base URL and records curated routing', async () => {
    const fixture = loadFixture('rdap/ch-gibberish-not-found.json');
    const response = fixture.response as { status: number; headers: Record<string, string>; body: string; truncated: boolean };
    h.http.respond = (request) => ({ ...response, url: request.url });
    const result = await handler.execute(item(fixture.domain), context(h.clock));
    expect(h.http.calls.map((call) => call.url)).toEqual([`https://rdap.nic.ch/domain/${fixture.domain}`]);
    expect(result.outcome).toBe('no_record');
    const parsed = RegistryObservation.parse({ ...observation(result).payload, freshness: 'fresh', reused: false });
    expect(parsed.source).toEqual({ registryId: 'switch', protocol: 'rdap', destination: 'https://rdap.nic.ch/', routing: 'curated' });
  });

  it('uses the DOMREG availability service query format for .lt', async () => {
    const fixture = loadFixture('whois/lt-free.json');
    h.whois.respond = () => fixture.response as { text: string; truncated: boolean };
    const result = await handler.execute(item(fixture.domain), context(h.clock));
    expect(h.whois.calls.map((call) => [call.host, call.port, call.query])).toEqual([['das.domreg.lt', 4343, `get 1.0 ${fixture.domain}`]]);
    expect([result.outcome, observation(result).payload.parserVersion]).toEqual(['no_record', 'das-domreg/1']);
  });
});

describe('published limits', () => {
  const at = (iso: string) => new Date(iso);
  const limit = (queries: number, windowSeconds: number): PublishedLimit => ({ queries, windowSeconds, source: 'test' });

  it('allows queries up to the limit, then names when the window reopens', () => {
    const limits = new PublishedLimits();
    for (let i = 0; i < 100; i++) expect(limits.reserve('r', [limit(100, 3600)], at('2026-10-05T12:00:00Z'))).toEqual({ waitMs: 0 });
    expect(limits.reserve('r', [limit(100, 3600)], at('2026-10-05T12:30:00Z'))).toEqual({ retryAt: '2026-10-05T13:00:00.000Z' });
    expect(limits.reserve('r', [limit(100, 3600)], at('2026-10-05T13:00:00Z'))).toEqual({ waitMs: 0 });
    expect(limits.reserve('other', [limit(100, 3600)], at('2026-10-05T12:30:00Z'))).toEqual({ waitMs: 0 });
  });

  it('spaces short intervals by waiting, up to the pacing bound', () => {
    const limits = new PublishedLimits();
    const now = at('2026-10-05T12:00:00Z');
    const waits = Array.from({ length: 8 }, () => limits.reserve('hk', [limit(1, 10)], now));
    expect(waits.slice(0, 7)).toEqual([0, 10, 20, 30, 40, 50, 60].map((s) => ({ waitMs: s * 1000 })));
    expect(MAX_PACING_WAIT_MS).toBe(60_000);
    expect(waits[7]).toEqual({ retryAt: '2026-10-05T12:01:10.000Z' });
  });

  it('applies every published window (hourly and daily)', () => {
    const limits = new PublishedLimits();
    const both = [limit(20, 3600), limit(200, 86_400)];
    for (let hour = 0; hour < 10; hour++) {
      for (let i = 0; i < 20; i++) expect(limits.reserve('ae', both, at(`2026-10-05T${String(hour).padStart(2, '0')}:00:00Z`))).toEqual({ waitMs: 0 });
    }
    expect(limits.reserve('ae', both, at('2026-10-05T10:00:00Z'))).toEqual({ retryAt: '2026-10-06T00:00:00.000Z' });
  });

  it('extends the item time limit only for routes with published limits', () => {
    expect(handler.timeoutMs(item('acme.hk'), DEFAULT_SETTINGS)).toBe(DEFAULT_SETTINGS.retries.timeoutMs + MAX_PACING_WAIT_MS);
    expect(handler.timeoutMs(item('acme.com'), DEFAULT_SETTINGS)).toBeUndefined();
  });

  it('stops at a long published limit without sending anything', async () => {
    const limits = h.moduleRef.get(PublishedLimits);
    for (let i = 0; i < 100; i++) limits.reserve('ie-domain-registry', data.whois.routes.find((r) => r.tld === 'ie')!.publishedLimits!, h.clock.now());
    const result = await handler.execute(item('acme.ie'), context(h.clock));
    expect(result).toMatchObject({
      outcome: 'rate_limited',
      resolved: false,
      evidence: [],
      retryable: true,
      cooldownUntil: '2026-10-06T12:00:00.000Z',
      retryAt: '2026-10-06T12:00:00.000Z',
      error: { code: 'published_rate_limit' },
    });
    expect(result.error?.message).toContain('https://www.weare.ie/whois-services-policy-2023/');
    expect(h.whois.calls).toHaveLength(0);
  });

  it('waits inside the item for a short published interval, then queries', async () => {
    const limits = h.moduleRef.get(PublishedLimits);
    const waits: number[] = [];
    limits.wait = async (ms) => {
      waits.push(ms);
    };
    const free = loadFixture('whois/hk-free.json');
    h.whois.respond = () => free.response as { text: string; truncated: boolean };
    await handler.execute(item('aaaa.hk'), context(h.clock, { allowCache: false }));
    const second = await handler.execute(item('bbbb.hk'), context(h.clock, { allowCache: false }));
    expect(waits).toEqual([0, 10_000]);
    expect(h.whois.calls).toHaveLength(2);
    expect(second.outcome).toBe('no_record');
  });

  it('does not query when the job is cancelled during the wait', async () => {
    const limits = h.moduleRef.get(PublishedLimits);
    limits.wait = async () => {
      throw new Error('aborted');
    };
    const result = await handler.execute(item('acme.hk'), context(h.clock));
    expect([result.outcome, result.error?.code]).toEqual(['inconclusive', 'aborted']);
    expect(h.whois.calls).toHaveLength(0);
  });
});

describe('test RDAP route overrides', () => {
  it('accepts only loopback URLs, so names never leave the machine', async () => {
    const { testRdapRoutes } = await import('../../src/registry/routes.service.js');
    const routes = testRdapRoutes('{"com":"http://127.0.0.1:4555"}');
    expect(routes.get('com')).toMatchObject({ endpoint: 'http://127.0.0.1:4555/', registryId: '127.0.0.1:4555', protocol: 'rdap' });
    expect(testRdapRoutes(undefined).size).toBe(0);
    expect(() => testRdapRoutes('{"com":"https://rdap.example.net/"}')).toThrow(/loopback/);
    expect(() => testRdapRoutes('not json')).toThrow(/JSON/);
  });
});
