import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESOLVED_ITEM_OUTCOMES, RegistryObservation } from '@domain-scout/contracts';
import { OperationRegistry } from '../../src/jobs/operation-registry.js';
import type { OperationResult } from '../../src/jobs/operation.js';
import { EvidenceRepository, hydrateObservation, type ObservationWrite } from '../../src/storage/evidence.js';
import { RegistryOperationHandler } from '../../src/registry/registry.handler.js';
import { context, createRegistryHarness, http, item, loadFixture } from './harness.js';

type Harness = Awaited<ReturnType<typeof createRegistryHarness>>;

let h: Harness;
let handler: RegistryOperationHandler;
let evidence: EvidenceRepository;

beforeEach(async () => {
  h = await createRegistryHarness();
  handler = h.moduleRef.get(RegistryOperationHandler);
  evidence = h.moduleRef.get(EvidenceRepository);
});
afterEach(() => h.close());

function respondWithFixture(file: string) {
  const fixture = loadFixture(file);
  const response = fixture.response as { status: number; headers: Record<string, string>; body: string; truncated: boolean };
  h.http.respond = (request) => ({ ...response, url: request.url });
  return fixture;
}

/** What the jobs engine does with the result: persist the evidence rows. */
function persist(result: OperationResult) {
  for (const write of result.evidence) if (write.kind === 'observation') evidence.insertObservation(write.row);
}

function observation(result: OperationResult): ObservationWrite {
  expect(result.evidence).toHaveLength(1);
  return (result.evidence[0] as { kind: 'observation'; row: ObservationWrite }).row;
}

describe('registration with OperationRegistry', () => {
  it('registers the registry operation', () => {
    expect(h.moduleRef.get(OperationRegistry).get('registry')).toBe(handler);
  });

  it('shares one budget key per registry and none for local outcomes', () => {
    expect(handler.sourceKey(item('example.com'))).toBe('registry:verisign');
    expect(handler.sourceKey(item('example.cc'))).toBe('registry:verisign');
    expect(handler.sourceKey(item('bbc.co.uk'))).toBe('registry:nominet');
    expect(handler.sourceKey(item('acme.de'))).toBe('registry:denic');
    expect(handler.sourceKey(item('acme.zw'))).toBeNull();
    expect(handler.sourceKey(item('www.example.com'))).toBeNull();
    expect(handler.destination(item('nic.si'))).toBe('https://rdap.register.si/');
    expect(handler.destination(item('acme.de'))).toBe('whois.denic.de:43');
  });
});

describe('registered and no_record evidence', () => {
  it('writes a contract-shaped observation with source, freshness window and parser version', async () => {
    respondWithFixture('rdap/com-example-registered.json');
    const result = await handler.execute(item('example.com'), context(h.clock));
    expect([result.outcome, result.resolved, result.retryable, result.error]).toEqual(['registered', true, false, null]);
    expect(h.http.calls.map((c) => [c.url, c.headers.accept, c.maxBytes])).toEqual([
      ['https://rdap.verisign.com/com/v1/domain/example.com', 'application/rdap+json', 1024 * 1024],
    ]);

    const row = observation(result);
    expect(row).toMatchObject({
      kind: 'registry',
      subject: 'example.com',
      suffix: 'com',
      sourceId: 'verisign',
      destination: 'https://rdap.verisign.com/com/v1/',
      outcome: 'registered',
      observedAt: '2026-10-05T12:00:00.000Z',
      staleAt: '2026-10-05T12:15:00.000Z',
      raw: null,
    });
    const parsed = RegistryObservation.parse({ ...row.payload, freshness: 'fresh', reused: false });
    expect(parsed).toMatchObject({
      source: { registryId: 'verisign', protocol: 'rdap', destination: 'https://rdap.verisign.com/com/v1/', routing: 'iana_bootstrap' },
      matchedName: 'example.com',
      parserVersion: 'rdap/1',
      httpStatus: 200,
      eligibility: { status: 'reserved' },
      hasRawDiagnostics: false,
    });
    expect(parsed.registration?.nameservers).toEqual(['elliott.ns.cloudflare.com', 'hera.ns.cloudflare.com']);
  });

  it('records no_record for an authoritative empty 404', async () => {
    const fixture = respondWithFixture('rdap/com-gibberish-not-found.json');
    const result = await handler.execute(item(fixture.domain), context(h.clock));
    expect([result.outcome, result.resolved]).toEqual(['no_record', true]);
    expect(observation(result).payload).toMatchObject({ eligibility: { status: 'unknown', source: null, scope: null }, registration: null });
  });

  it('stores sanitized raw diagnostics only when enabled', async () => {
    respondWithFixture('rdap/si-nic-registered.json');
    const off = await handler.execute(item('nic.si'), context(h.clock, { allowCache: false }));
    expect(observation(off).raw).toBeNull();
    const on = await handler.execute(item('nic.si'), context(h.clock, { allowCache: false, settings: { privacy: { keepRawDiagnostics: true } } }));
    const row = observation(on);
    expect(row.raw).toMatchObject({ contentType: 'application/rdap+JSON', truncated: false });
    expect(row.raw!.body).toContain('"ldhName":"nic.si"');
    expect(row.payload.hasRawDiagnostics).toBe(true);
  });

  it('routes WHOIS suffixes with the registry query format', async () => {
    const fixture = loadFixture('whois/de-free.json');
    h.whois.respond = () => fixture.response as { text: string; truncated: boolean };
    const result = await handler.execute(item(fixture.domain), context(h.clock));
    expect(h.whois.calls.map((c) => [c.host, c.port, c.query])).toEqual([['whois.denic.de', 43, `-T dn,ace ${fixture.domain}`]]);
    expect(result.outcome).toBe('no_record');
    expect(observation(result).payload).toMatchObject({
      source: { registryId: 'denic', protocol: 'whois', destination: 'whois.denic.de:43', routing: 'curated' },
      parserVersion: 'whois-denic/1',
    });
    expect(h.http.calls).toHaveLength(0);
  });
});

describe('cache reuse versus recheck', () => {
  it('reuses fresh resolved evidence without a network call, and rechecks when cache is off or stale', async () => {
    respondWithFixture('rdap/com-google-registered.json');
    const first = await handler.execute(item('google.com'), context(h.clock));
    persist(first);
    const firstId = observation(first).id;
    expect(h.http.calls).toHaveLength(1);

    h.clock.advance(10 * 60_000);
    const reused = await handler.execute(item('google.com'), context(h.clock));
    expect(reused).toEqual({ outcome: 'registered', resolved: true, evidence: [], reused: { registryObservationId: firstId } });
    expect(h.http.calls).toHaveLength(1);

    const recheck = await handler.execute(item('google.com'), context(h.clock, { allowCache: false }));
    expect(observation(recheck).id).not.toBe(firstId);
    expect(h.http.calls).toHaveLength(2);
    persist(recheck);

    h.clock.advance(16 * 60_000);
    const stale = await handler.execute(item('google.com'), context(h.clock));
    expect(stale.reused).toBeUndefined();
    expect(h.http.calls).toHaveLength(3);

    // Prior evidence stays identifiable after rechecks (A09).
    const rows = evidence.observations('registry', 'google.com');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => hydrateObservation<{ freshness: string }>(r, h.clock.now()).freshness)).toEqual(['stale', 'stale']);
  });

  it('never reuses unresolved evidence', async () => {
    h.http.respond = () => http(503);
    const failed = await handler.execute(item('google.com'), context(h.clock));
    expect([failed.outcome, failed.resolved, failed.retryable]).toEqual(['inconclusive', false, true]);
    persist(failed);
    respondWithFixture('rdap/com-google-registered.json');
    const next = await handler.execute(item('google.com'), context(h.clock));
    expect(next.outcome).toBe('registered');
    expect(h.http.calls).toHaveLength(2);
  });
});

describe('local outcomes never touch the network', () => {
  it('answers unsupported suffixes locally, unresolved and not retryable', async () => {
    const result = await handler.execute(item('acme.zw'), context(h.clock, { allowCache: false }));
    expect([result.outcome, result.resolved, result.retryable]).toEqual(['unsupported', false, false]);
    expect(RESOLVED_ITEM_OUTCOMES.registry).not.toContain('unsupported');
    const row = observation(result);
    expect([row.sourceId, row.destination]).toEqual([null, null]);
    expect(RegistryObservation.parse({ ...row.payload, freshness: 'fresh', reused: false })).toMatchObject({
      source: null,
      reason: { code: 'no_registry_route' },
    });
    expect(h.http.calls).toHaveLength(0);
    expect(h.whois.calls).toHaveLength(0);
  });

  it('answers invalid names locally as resolved', async () => {
    for (const subject of ['www.example.com', 'acme.github.io', 'co.uk']) {
      const result = await handler.execute(item(subject), context(h.clock));
      expect([subject, result.outcome, result.resolved, result.retryable]).toEqual([subject, 'invalid', true, false]);
      expect(observation(result).payload).toMatchObject({ source: null, reason: { code: 'invalid_domain' } });
    }
    expect(observation(await handler.execute(item('www.example.com'), context(h.clock))).payload.reason).toMatchObject({
      message: expect.stringContaining('Suggested: example.com'),
    });
    expect(h.http.calls).toHaveLength(0);
    expect(h.whois.calls).toHaveLength(0);
  });
});

describe('review regressions: local outcomes', () => {
  it('treats an unknown extension as unsupported, not as a definitive invalid answer', async () => {
    const result = await handler.execute(item('acme.zzzz'), context(h.clock));
    expect([result.outcome, result.resolved, result.retryable, result.error?.code]).toEqual(['unsupported', false, false, 'unknown_suffix']);
    expect(observation(result).payload).toMatchObject({ source: null, suffix: 'zzzz' });
    expect(h.http.calls).toHaveLength(0);
  });

  it('emits no observation for a subject that cannot satisfy AsciiDomain', async () => {
    const result = await handler.execute(item('bad_name.com'), context(h.clock));
    expect([result.outcome, result.resolved, result.evidence]).toEqual(['invalid', true, []]);
    expect(result.error?.message).toContain('not allowed');
  });
});

describe('redirects', () => {
  it('refuses a redirect to a query for another name, even on the same operator', async () => {
    h.http.respond = (request) =>
      request.url.endsWith('/domain/google.com') ? http(302, '', { location: '/com/v1/domain/other-name.com' }) : http(404, '');
    const result = await handler.execute(item('google.com'), context(h.clock));
    expect([result.outcome, result.error?.code]).toEqual(['inconclusive', 'redirect_refused']);
    expect(h.http.calls).toHaveLength(1);
  });

  it('refuses redirects to hosts that are not verified registry RDAP hosts', async () => {
    h.http.respond = () => http(302, '', { location: 'https://rdap.some-registrar.test/domain/google.com' });
    const result = await handler.execute(item('google.com'), context(h.clock));
    expect([result.outcome, result.error?.code]).toEqual(['inconclusive', 'redirect_refused']);
    expect(h.http.calls).toHaveLength(1);
  });

  it('refuses plain-HTTP redirects even to a registry host', async () => {
    h.http.respond = () => http(301, '', { location: 'http://rdap.verisign.com/com/v1/domain/google.com' });
    expect((await handler.execute(item('google.com'), context(h.clock))).error?.code).toBe('redirect_refused');
  });

  it('follows a redirect to another verified registry host and still checks identity', async () => {
    const fixture = loadFixture('rdap/com-google-registered.json');
    const body = (fixture.response as { body: string }).body;
    h.http.respond = (request) =>
      request.url.startsWith('https://rdap.verisign.com/')
        ? http(307, '', { location: 'https://tld-rdap.verisign.com/com/v1/domain/google.com' })
        : http(200, body, { 'content-type': 'application/rdap+json' });
    const result = await handler.execute(item('google.com'), context(h.clock));
    expect(result.outcome).toBe('registered');
    expect(h.http.calls.map((c) => c.url)).toEqual([
      'https://rdap.verisign.com/com/v1/domain/google.com',
      'https://tld-rdap.verisign.com/com/v1/domain/google.com',
    ]);
    expect(observation(result).payload).toMatchObject({ reason: { message: expect.stringContaining('after redirect to tld-rdap.verisign.com') } });
  });

  it('accepts a 404 only from the routed registry operator', async () => {
    const redirectTo = (target: string) => (request: { url: string }) =>
      request.url.startsWith('https://rdap.verisign.com/') ? http(302, '', { location: target }) : http(404, '');
    h.http.respond = redirectTo('https://rdap.nominet.uk/uk/domain/abc.com');
    const other = await handler.execute(item('abc.com'), context(h.clock));
    expect([other.outcome, other.error?.code]).toEqual(['inconclusive', 'unverified_negative']);

    h.http.respond = redirectTo('https://tld-rdap.verisign.com/com/v1/domain/abc.com');
    expect((await handler.execute(item('abc.com'), context(h.clock))).outcome).toBe('no_record');
  });

  it('stops redirect loops', async () => {
    h.http.respond = () => http(302, '', { location: 'https://rdap.verisign.com/com/v1/domain/google.com' });
    expect((await handler.execute(item('google.com'), context(h.clock))).error?.code).toBe('too_many_redirects');
    expect(h.http.calls).toHaveLength(4);
  });
});

describe('failures', () => {
  it('turns 429 into a shared cooldown with retryAt', async () => {
    respondWithFixture('rdap/com-rate-limited-429-seconds.json');
    const result = await handler.execute(item('google.com'), context(h.clock));
    expect(result).toMatchObject({
      outcome: 'rate_limited',
      resolved: false,
      retryable: true,
      cooldownUntil: '2026-10-05T12:02:00.000Z',
      retryAt: '2026-10-05T12:02:00.000Z',
      error: { code: 'rate_limited', retryable: true },
    });
  });

  it('classifies network errors and timeouts as retryable inconclusive', async () => {
    h.http.respond = () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    };
    const network = await handler.execute(item('google.com'), context(h.clock));
    expect([network.outcome, network.error?.code, network.retryable]).toEqual(['inconclusive', 'network_error', true]);
    expect(observation(network).payload).toMatchObject({ reason: { message: expect.stringContaining('ECONNRESET') } });

    h.http.respond = (request) =>
      new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    const timeout = await handler.execute(item('google.com'), context(h.clock, { settings: { retries: { maxAttempts: 3, timeoutMs: 1000 } } }));
    expect([timeout.outcome, timeout.error?.code, timeout.retryable]).toEqual(['inconclusive', 'timeout', true]);
  });

  it('returns no evidence when the job aborts the call', async () => {
    const controller = new AbortController();
    h.http.respond = (request) => {
      controller.abort();
      return Promise.reject(request.signal.reason);
    };
    const result = await handler.execute(item('google.com'), context(h.clock, { signal: controller.signal }));
    expect([result.outcome, result.evidence, result.error?.code]).toEqual(['inconclusive', [], 'aborted']);
  });

  it('turns a dropped WHOIS connection into retryable inconclusive', async () => {
    h.whois.respond = () => ({ text: 'Domain: acme.de\nStat', truncated: true });
    const result = await handler.execute(item('acme.de'), context(h.clock));
    expect([result.outcome, result.error?.code, result.retryable]).toEqual(['inconclusive', 'truncated_response', true]);
  });
});
