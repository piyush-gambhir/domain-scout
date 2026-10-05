import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NormalizedDomain } from '@domain-scout/contracts';
import { domainToUnicode } from 'node:url';
import { loadRegistryData } from '../../src/registry/data.js';
import { classifyRdap } from '../../src/registry/rdap/rdap-classifier.js';
import { parseRetryAfter } from '../../src/registry/retry-after.js';
import { WHOIS_PARSERS, classifyWhois } from '../../src/registry/whois/whois-classifiers.js';
import type { Classification } from '../../src/registry/classification.js';
import { loadFixture, type RegistryFixture } from './harness.js';

const NOW = new Date('2026-10-05T12:00:00.000Z');

function normalized(ascii: string): NormalizedDomain {
  const suffix = ascii.endsWith('.co.uk') ? 'co.uk' : ascii.slice(ascii.lastIndexOf('.') + 1);
  return {
    ascii,
    unicode: domainToUnicode(ascii),
    label: ascii.slice(0, ascii.length - suffix.length - 1),
    suffix,
    isIdn: ascii.includes('xn--'),
  };
}

function classifyFixture(fixture: RegistryFixture): Classification {
  const domain = normalized(fixture.domain);
  if (fixture.protocol === 'rdap') {
    const response = fixture.response as { status: number; headers: Record<string, string>; body: string; truncated: boolean };
    return classifyRdap(
      domain,
      { registryHost: new URL(fixture.route).host, finalUrl: `${fixture.route}domain/${fixture.domain}`, ...response },
      NOW,
    );
  }
  const spec = loadRegistryData().whois.routes.find((route) => `${route.host}:${route.port}` === fixture.route)!;
  const response = fixture.response as { text: string; truncated: boolean };
  return classifyWhois(WHOIS_PARSERS[spec.parser]!, response, { domain, spec, now: NOW });
}

const manifest = loadRegistryData().fixtures.fixtures;

describe('fixture manifest', () => {
  it('lists every fixture file and only existing ones', () => {
    for (const entry of manifest) {
      expect(existsSync(new URL(`../fixtures/registry/${entry.file}`, import.meta.url)), entry.file).toBe(true);
    }
    expect(manifest.length).toBeGreaterThanOrEqual(30);
  });

  it('carries provenance on every fixture', () => {
    for (const entry of manifest) {
      const fixture = loadFixture(entry.file);
      expect(fixture.provenance.kind, entry.file).toBe(entry.kind);
      expect(fixture.provenance.notes.length, entry.file).toBeGreaterThan(20);
      if (fixture.provenance.kind === 'captured_live') expect(fixture.provenance.capturedAt, entry.file).toMatch(/^2026-10-05T/);
      expect(fixture.expected.outcome, entry.file).toBe(entry.expected);
    }
  });

  it('covers the required cases', () => {
    const files = manifest.map((entry) => entry.file);
    for (const required of [
      'rdap/com-example-registered.json',
      'rdap/com-gibberish-not-found.json',
      'rdap/si-nic-registered.json',
      'rdap/si-gibberish-not-found.json',
      'rdap/co-uk-bbc-registered.json',
      'rdap/com-idn-registered.json',
      'rdap/com-rate-limited-429-seconds.json',
      'rdap/si-html-404.json',
      'rdap/com-identity-mismatch.json',
      'whois/de-registered.json',
      'whois/de-free.json',
      'whois/io-registered.json',
      'whois/io-free.json',
      'whois/de-truncated.json',
    ]) {
      expect(files).toContain(required);
    }
  });
});

describe.each(manifest.map((entry) => [entry.file]))('fixture %s', (file) => {
  const fixture = loadFixture(file);
  const result = classifyFixture(fixture);

  it('classifies as expected', () => {
    expect(result.outcome).toBe(fixture.expected.outcome);
    expect(result.reason.code).toBe(fixture.expected.reasonCode);
    expect(result.matchedName).toBe(fixture.expected.matchedName);
    expect(result.eligibility.status).toBe(fixture.expected.eligibility);
    if (fixture.expected.registrar !== undefined) expect(result.registration?.registrar).toBe(fixture.expected.registrar);
    if (fixture.expected.expiresAt !== undefined) expect(result.registration?.expiresAt).toBe(fixture.expected.expiresAt);
    if (fixture.expected.dnssec !== undefined) expect(result.registration?.dnssec).toBe(fixture.expected.dnssec);
    if (fixture.expected.cooldownSeconds !== undefined) {
      expect(Date.parse(result.cooldownUntil!) - NOW.getTime()).toBe(fixture.expected.cooldownSeconds * 1000);
    }
    if (fixture.expected.cooldownUntil !== undefined) expect(result.cooldownUntil).toBe(fixture.expected.cooldownUntil);
  });

  it('never reports an unresolved outcome with registration details', () => {
    if (result.outcome !== 'registered') expect(result.registration).toBeNull();
    if (result.outcome === 'no_record') expect(result.reason.message).toContain('does not establish that the name can be registered');
  });
});

describe('RDAP status handling', () => {
  const domain = normalized('fhscaevkizwukbrsktchdjqo.com');
  const exchange = (status: number, body = '', headers: Record<string, string> = {}, truncated = false) =>
    classifyRdap(domain, { registryHost: 'rdap.verisign.com', finalUrl: 'https://rdap.verisign.com/com/v1/domain/x', status, headers, body, truncated }, NOW);

  it.each([
    [403, 'blocked', 'blocked', false],
    [451, 'blocked', 'blocked', false],
    [500, 'inconclusive', 'server_error', true],
    [502, 'inconclusive', 'server_error', true],
    [400, 'inconclusive', 'registry_rejected_query', false],
    [418, 'inconclusive', 'unexpected_status', false],
  ] as const)('HTTP %i is %s (%s)', (status, outcome, code, retryable) => {
    const result = exchange(status, '{}', { 'content-type': 'application/rdap+json' });
    expect([result.outcome, result.reason.code, result.retryable, result.httpStatus]).toEqual([outcome, code, retryable, status]);
  });

  it('applies a default cooldown to 403 and none to 451', () => {
    expect(exchange(403).cooldownUntil).toBe('2026-10-05T12:05:00.000Z');
    expect(exchange(451).cooldownUntil).toBeNull();
  });

  it('honors Retry-After on 503 and defaults 429 without one', () => {
    expect(exchange(503, '', { 'retry-after': '30' }).cooldownUntil).toBe('2026-10-05T12:00:30.000Z');
    const limited = exchange(429);
    expect([limited.outcome, limited.cooldownUntil, limited.retryAt, limited.retryable]).toEqual([
      'rate_limited',
      '2026-10-05T12:01:00.000Z',
      '2026-10-05T12:01:00.000Z',
      true,
    ]);
  });

  it('treats malformed, HTML, truncated or anonymous 200 answers as inconclusive', () => {
    expect(exchange(200, '{"objectClassName":"domain",', { 'content-type': 'application/rdap+json' }).reason.code).toBe('malformed_response');
    expect(exchange(200, '<html></html>', { 'content-type': 'text/html' }).reason.code).toBe('unexpected_content_type');
    expect(exchange(200, '{"objectClassName":"domain"}', {}, true).reason.code).toBe('truncated_response');
    expect(exchange(200, '{"objectClassName":"domain"}').reason.code).toBe('missing_identity');
    expect(exchange(200, '{"errorCode":404,"title":"Not Found"}').reason.code).toBe('malformed_response');
  });

  it('does not accept a 404 whose RDAP errorCode says otherwise', () => {
    expect(exchange(404, '{"errorCode":500,"title":"Internal error"}', { 'content-type': 'application/rdap+json' }).reason.code).toBe('unexpected_404_body');
    expect(exchange(404, '{"errorCode":"404"}', { 'content-type': 'application/rdap+json' }).outcome).toBe('no_record');
    expect(exchange(404, '{"rdapConformance":["rdap_level_0"],"title":"Not Found"}').outcome).toBe('no_record');
    for (const body of ['{}', '{"message":"backend failure"}', '{"errorCode":[404]}', '[]']) {
      expect(exchange(404, body, { 'content-type': 'application/json' }).outcome, body).toBe('inconclusive');
    }
  });

  it('treats non-JSON text 404 bodies as inconclusive', () => {
    expect(exchange(404, 'Not Found', { 'content-type': 'text/plain' }).outcome).toBe('inconclusive');
    expect(exchange(404, '{"errorCode":404}', { 'content-type': 'application/json' }, true).reason.code).toBe('truncated_response');
  });

  it('matches identity through unicodeName when ldhName is missing', () => {
    const idn = normalized('xn--bcher-kva.com');
    const result = classifyRdap(
      idn,
      { registryHost: 'rdap.verisign.com', finalUrl: '', status: 200, headers: {}, body: JSON.stringify({ objectClassName: 'domain', unicodeName: 'Bücher.com.' }), truncated: false },
      NOW,
    );
    expect([result.outcome, result.matchedName]).toEqual(['registered', 'xn--bcher-kva.com']);
  });

  it('reports reserved eligibility only from an explicit RDAP status', () => {
    const body = (status: string[]) => JSON.stringify({ objectClassName: 'domain', ldhName: domain.ascii, status });
    expect(exchange(200, body(['reserved'])).eligibility.status).toBe('reserved');
    expect(exchange(200, body(['server hold', 'inactive'])).eligibility.status).toBe('unknown');
  });
});

describe('WHOIS classifier rules', () => {
  const spec = (parser: string) => loadRegistryData().whois.routes.find((route) => route.parser === parser)!;
  const run = (parser: string, ascii: string, text: string, truncated = false) =>
    classifyWhois(WHOIS_PARSERS[parser]!, { text, truncated }, { domain: normalized(ascii), spec: spec(parser), now: NOW });

  it('never treats a short unknown reply as free', () => {
    for (const parser of Object.keys(WHOIS_PARSERS)) {
      for (const text of ['OK', 'not found', 'available', 'Error', '%']) {
        expect(run(parser, `acme.${spec(parser).tld}`, text).outcome, `${parser}: ${text}`).toBe('inconclusive');
      }
    }
  });

  it('treats empty replies as inconclusive and retryable', () => {
    const result = run('denic', 'acme.de', '   \n');
    expect([result.outcome, result.reason.code, result.retryable]).toEqual(['inconclusive', 'empty_response', true]);
  });

  it('rejects records for another name', () => {
    const result = run('denic', 'acme.de', 'Domain: other.de\nStatus: free\n');
    expect([result.outcome, result.reason.code, result.matchedName]).toEqual(['inconclusive', 'identity_mismatch', 'other.de']);
  });

  it('keeps DENIC redemptionPeriod as registered and unknown statuses inconclusive', () => {
    expect(run('denic', 'acme.de', 'Domain: acme.de\nStatus: redemptionPeriod\n').outcome).toBe('registered');
    expect(run('denic', 'acme.de', 'Domain: acme.de\nStatus: somethingNew\n').reason.code).toBe('unknown_status');
    expect(run('denic', 'acme.de', '% Error: 55000000010 Invalid query\n').reason.code).toBe('registry_error');
  });

  it('does not read the .io terms of use as throttling', () => {
    const text = 'Queries to the Whois services are throttled. If too many queries are received from a single IP address the service will reject further queries.\n';
    expect(run('nic-io', 'acme.io', text).reason.code).toBe('unrecognized_response');
  });

  it('requires the full record shape before reporting registered', () => {
    for (const [parser, ascii, text] of [
      ['nic-io', 'acme.io', 'Domain Name: acme.io\n'],
      ['jprs', 'acme.jp', 'Domain Information:\n[Domain Name]                   ACME.JP\n'],
      ['cnnic', 'acme.cn', 'Domain Name: acme.cn\nROID: 1-cn\n'],
      ['eurid', 'acme.eu', 'Domain: acme.eu\nScript: LATIN\n'],
      ['denic', 'acme.de', 'Domain: acme.de\n'],
      ['denic', 'acme.de', 'Domain: acme.de\nStatus:\nconnect\n'],
      ['nic-io', 'acme.io', 'Domain Name: acme.io\nCreation Date:\nRegistrar: Example\n'],
      ['jprs', 'acme.jp', '[Domain Name]                   ACME.JP\n[Status]\n[Name Server]                   ns1.example.test\n'],
      ['cnnic', 'acme.cn', 'Domain Name: acme.cn\nRegistration Time:\nExpiration Time:\n'],
    ] as const) {
      const result = run(parser, ascii, text);
      expect([parser, result.outcome], text).toEqual([parser, 'inconclusive']);
    }
  });

  it('reports EURid statuses other than AVAILABLE as inconclusive', () => {
    expect(run('eurid', 'acme.eu', 'Domain: acme.eu\nStatus: NOT ALLOWED\n').reason.code).toBe('unknown_status');
  });

  it('caps the EURid grace period at one day', () => {
    const result = run('eurid', 'acme.eu', '% Excessive querying, grace period of 7777777 seconds.\n');
    expect(result.cooldownUntil).toBe('2026-10-06T12:00:00.000Z');
  });
});

describe('parseRetryAfter', () => {
  it.each([
    ['120', '2026-10-05T12:02:00.000Z'],
    ['0', '2026-10-05T12:00:00.000Z'],
    [' 5 ', '2026-10-05T12:00:05.000Z'],
    ['Mon, 05 Oct 2026 12:10:00 GMT', '2026-10-05T12:10:00.000Z'],
    ['Monday, 05-Oct-26 12:10:00 GMT', '2026-10-05T12:10:00.000Z'],
    ['Mon, 05 Oct 2026 11:00:00 GMT', '2026-10-05T12:00:00.000Z'],
  ])('%s -> %s', (value, expected) => {
    expect(parseRetryAfter(value, NOW)).toBe(expected);
  });

  it.each([[null], [undefined], [''], ['soon'], ['-5'], ['1.5'], ['12345678901234567890'], ['8640000000001']])('rejects %s', (value) => {
    expect(parseRetryAfter(value as string | null | undefined, NOW)).toBeNull();
  });
});
