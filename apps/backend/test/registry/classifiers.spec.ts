import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NormalizedDomain } from '@domain-scout/contracts';
import { domainToUnicode } from 'node:url';
import { parse as parseHost } from 'tldts';
import { loadRegistryData } from '../../src/registry/data.js';
import { classifyRdap } from '../../src/registry/rdap/rdap-classifier.js';
import { parseRetryAfter } from '../../src/registry/retry-after.js';
import { WHOIS_PARSERS, classifyWhois } from '../../src/registry/whois/whois-classifiers.js';
import type { Classification } from '../../src/registry/classification.js';
import { loadFixture, type RegistryFixture } from './harness.js';

const NOW = new Date('2026-10-05T12:00:00.000Z');

function normalized(ascii: string): NormalizedDomain {
  const suffix = parseHost(ascii, { allowPrivateDomains: false }).publicSuffix ?? ascii.slice(ascii.lastIndexOf('.') + 1);
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
    expect(run('identity-digital', 'acme.io', text).reason.code).toBe('unrecognized_response');
  });

  it('requires the full record shape before reporting registered', () => {
    for (const [parser, ascii, text] of [
      ['identity-digital', 'acme.io', 'Domain Name: acme.io\n'],
      ['jprs', 'acme.jp', 'Domain Information:\n[Domain Name]                   ACME.JP\n'],
      ['cnnic', 'acme.cn', 'Domain Name: acme.cn\nROID: 1-cn\n'],
      ['eurid', 'acme.eu', 'Domain: acme.eu\nScript: LATIN\n'],
      ['denic', 'acme.de', 'Domain: acme.de\n'],
      ['denic', 'acme.de', 'Domain: acme.de\nStatus:\nconnect\n'],
      ['identity-digital', 'acme.io', 'Domain Name: acme.io\nCreation Date:\nRegistrar: Example\n'],
      ['jprs', 'acme.jp', '[Domain Name]                   ACME.JP\n[Status]\n[Name Server]                   ns1.example.test\n'],
      ['cnnic', 'acme.cn', 'Domain Name: acme.cn\nRegistration Time:\nExpiration Time:\n'],
    ] as const) {
      const result = run(parser, ascii, text);
      expect([parser, result.outcome], text).toEqual([parser, 'inconclusive']);
    }
  });

  it('treats replies that mix records or add a not-found line as conflicting', () => {
    for (const [parser, ascii, text] of [
      ['denic', 'acme.de', 'Domain: acme.de\nStatus: free\nDomain: other.de\nStatus: connect\n'],
      ['denic', 'acme.de', 'Domain: acme.de\nStatus: free\nStatus: connect\n'],
      ['jprs', 'acme.jp', '[Domain Name]                   ACME.JP\n[State]                         Connected (2027/01/31)\nNo match!!\n'],
      ['cnnic', 'acme.cn', 'Domain Name: acme.cn\nRegistration Time: 2020-01-01 00:00:00\nExpiration Time: 2027-01-01 00:00:00\nNo matching record.\n'],
      ['eurid', 'acme.eu', 'Domain: acme.eu\nStatus: AVAILABLE\nDomain: other.eu\n'],
    ] as const) {
      expect([parser, run(parser, ascii, text).reason.code], text).toEqual([parser, 'conflicting_reply']);
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

describe('ccTLD WHOIS classifier rules', () => {
  const spec = (parser: string) => loadRegistryData().whois.routes.find((route) => route.parser === parser)!;
  const run = (parser: string, ascii: string, text: string) =>
    classifyWhois(WHOIS_PARSERS[parser]!, { text, truncated: false }, { domain: normalized(ascii), spec: spec(parser), now: NOW });

  it('has a classifier for every curated route and no unused one', () => {
    const routed = new Set(loadRegistryData().whois.routes.map((route) => route.parser));
    expect([...routed].filter((parser) => !WHOIS_PARSERS[parser])).toEqual([]);
    expect(Object.keys(WHOIS_PARSERS).filter((parser) => !routed.has(parser))).toEqual([]);
  });

  it('reports a record without its registry-specific shape as inconclusive', () => {
    for (const [parser, ascii, text] of [
      ['dns-belgium', 'acme.be', 'Domain:\tacme.be\n'],
      ['internetstiftelsen', 'acme.se', 'state:            active\ndomain:           acme.se\n'],
      ['punktum', 'acme.dk', 'Domain:               acme.dk\nStatus:               Active\n'],
      ['dns-pt', 'acme.pt', 'Domain: acme.pt\nDomain Status: Registered\n'],
      ['nic-mexico', 'acme.mx', 'Domain Name:       acme.mx\n'],
      ['channel-isles', 'acme.gg', 'Domain:\n     acme.gg\n'],
      ['amnic', 'acme.am', '   Domain name: acme.am\n'],
      ['nic-im', 'acme.im', 'Domain Name:\tacme.im\n'],
      ['eis', 'acme.ee', 'Domain:\nname:       acme.ee\n\nEstonia .ee Top Level Domain WHOIS server\n'],
      ['sk-nic', 'acme.sk', 'Domain:                       acme.sk\n'],
      ['rnids', 'acme.rs', 'Domain name: acme.rs\n'],
      ['nic-hu', 'acme.hu', 'domain:         acme.hu\n'],
      ['registro-it', 'acme.it', 'Domain:             acme.it\nStatus:             ok\n'],
      ['nic-at', 'acme.at', 'domain:         acme.at\n'],
      ['hkirc', 'acme.hk', 'Domain Name:  ACME.HK \n'],
      ['tci', 'acme.ru', '% TCI Whois Service. Terms of use:\n\ndomain:        ACME.RU\n'],
      ['trabis', 'acme.tr', '** Domain Name: acme.tr\n'],
      ['isoc-il', 'acme.co.il', 'domain:       acme.co.il\n'],
      ['aeda', 'acme.ae', 'Domain Name:                     acme.ae\n'],
      ['saudinic', 'acme.sa', 'Domain Name: ACME.SA\n'],
      ['nic-so', 'acme.so', 'Domain Name: acme.so\n'],
      ['centralnic', 'acme.la', 'Domain Name: ACME.LA\nCreation Date: 2020-01-01T00:00:00.0Z\n'],
      ['zarc', 'acme.co.za', 'Domain Name: acme.co.za\n'],
      ['us-registry', 'acme.us', 'Domain Name: acme.us\nRegistrar: Example\n'],
    ] as const) {
      const result = run(parser, ascii, text);
      expect([parser, result.outcome, result.registration], text).toEqual([parser, 'inconclusive', null]);
    }
  });

  it('rejects negative replies that name another domain', () => {
    for (const [parser, ascii, text] of [
      ['website-ws', 'acme.ws', 'The queried object does not exist: other.ws.\n'],
      ['weare-ie', 'acme.ie', 'Not found: other.ie\n'],
      ['internetnz', 'acme.nz', 'Not found: other.nz\n'],
      ['dns-pt', 'acme.pt', 'other.pt - No Match\n'],
      ['internetstiftelsen', 'acme.se', 'domain "other.se" not found.\n'],
      ['trabis', 'acme.tr', 'No match found for other.tr\n'],
      ['saudinic', 'acme.sa', 'No Match for domain: other.sa\n'],
      ['nic-so', 'acme.so', 'Domain Name: other.so\nThe queried object does not exist: No Object Found\n'],
      ['nic-im', 'acme.im', 'Domain Name:\tother.im\nThe domain other.im was not found.\n'],
      ['dns-lu', 'acme.lu', '% WHOIS other.lu\n% No such domain\n'],
      ['dns-belgium', 'acme.be', 'Domain:\tother.be\nStatus:\tAVAILABLE\n'],
      ['register-bg', 'acme.bg', 'DOMAIN NAME: other.bg (other.bg)\nregistration status: available\n'],
      ['nic-lv', 'acme.lv', '[Domain]\nDomain: other.lv\nStatus: free\n'],
      ['domreg-das', 'acme.lt', '% .lt registry DAS service\nDomain: other.lt\nStatus: available\n'],
      ['registro-it', 'acme.it', 'Domain:             other.it\nStatus:             AVAILABLE\n'],
    ] as const) {
      const result = run(parser, ascii, text);
      expect([parser, result.outcome, result.reason.code], text).toEqual([parser, 'inconclusive', 'identity_mismatch']);
    }
  });

  it('treats a reply carrying both a record and the negative text as inconclusive', () => {
    for (const [parser, ascii, text] of [
      ['identity-digital', 'acme.io', 'Domain Name: acme.io\nDomain not found.\n'],
      ['nic-mexico', 'acme.mx', 'Domain Name:       acme.mx\nNo_Se_Encontro_El_Objeto/Object_Not_Found\n'],
      ['sk-nic', 'acme.sk', 'Domain:                       acme.sk\nDomain not found.\n'],
      ['nic-hu', 'acme.hu', 'domain:         acme.hu\nNincs talalat / No match\n'],
      ['nic-at', 'acme.at', 'domain:         acme.at\n% nothing found\n'],
      ['tci', 'acme.ru', '% TCI Whois Service\ndomain:        ACME.RU\nNo entries found for the selected source(s).\n'],
      ['isoc-il', 'acme.co.il', 'domain:       acme.co.il\n% No data was found to match the request criteria.\n'],
    ] as const) {
      expect([parser, run(parser, ascii, text).outcome], text).toEqual([parser, 'inconclusive']);
    }
  });

  it('treats a negative plus record lines, or two statuses, as conflicting', () => {
    for (const [parser, ascii, text] of [
      ['internetstiftelsen', 'acme.se', 'domain "acme.se" not found.\ndomain:           acme.se\nstate:            active\ncreated:          2020-01-01\n'],
      ['punktum', 'acme.dk', 'No entries found for the selected source.\nDomain:               acme.dk\nRegistered:           2001-01-01\nStatus:               Active\n'],
      ['dns-pt', 'acme.pt', 'acme.pt - No Match\nDomain: acme.pt\nDomain Status: Registered\nCreation Date: 01/01/2001 00:00:00\n'],
      ['dns-lu', 'acme.lu', '% WHOIS acme.lu\n% No such domain\ndomainname:     acme.lu\ndomaintype:     ACTIVE\n'],
      ['eis', 'acme.ee', '\nDomain not found\nDomain:\nname:       acme.ee\nstatus:     ok\nregistered: 2010-07-04\n\nEstonia .ee Top Level Domain WHOIS server\n'],
      ['rnids', 'acme.rs', '%ERROR:103: Domain is not registered\nDomain name: acme.rs\nDomain status: Active\nRegistration date: 07.09.2020 10:06:53\n'],
      ['nic-so', 'acme.so', 'Domain Name: acme.so\nThe queried object does not exist: No Object Found\nRegistry Domain ID: 1-sonic\nCreation Date: 2020-01-01T00:00:00Z\n'],
      ['dns-belgium', 'acme.be', 'Domain:\tacme.be\nStatus:\tAVAILABLE\nStatus:\tREGISTERED\n'],
      ['trabis', 'acme.tr', 'No match found for acme.tr\n** Domain Name: acme.tr\nDomain Status: Active\nCreated on..............: 2004-Nov-09.\n'],
      ['saudinic', 'acme.sa', 'No Match for domain: acme.sa\nDomain Name: acme.sa\nName Server: ns1.example.test\n'],
      ['registro-it', 'acme.it', 'Domain:             acme.it\nStatus:             AVAILABLE\nStatus:             ok\nCreated:            2020-01-01 00:00:00\n'],
    ] as const) {
      const result = run(parser, ascii, text);
      expect([parser, result.outcome, result.reason.code], text).toEqual([parser, 'inconclusive', 'conflicting_reply']);
    }
  });

  it('does not let a second record supply identity or required fields', () => {
    for (const [parser, ascii, text] of [
      ['weare-ie', 'acme.ie', 'Domain Name: acme.ie\nDomain Name: other.ie\nRegistry Domain ID: 1-IEDR\nCreation Date: 2020-01-01T00:00:00Z\nRegistrar: Other Registrar\n'],
      ['nic-im', 'acme.im', 'Domain Name:\tother.im\nThe domain acme.im was not found.\n'],
      ['dns-belgium', 'acme.be', 'Domain:\tacme.be\nA-label:\tother.be\nStatus:\tNOT AVAILABLE\n'],
      ['punktum', 'acme.dk', 'Domain:               acme.dk\nDNS:                  other.dk\nRegistered:           2001-01-01\nStatus:               Active\n'],
      ['register-bg', 'acme.bg', 'DOMAIN NAME: acme.bg (other.bg)\nregistration status: busy, active\n'],
      ['hkirc', 'acme.hk', 'Domain Name:  ACME.HK\nDomain Name:  OTHER.HK\nDomain Status: Active\nDomain Name Commencement Date: 14-07-2001\n'],
      ['nic-lv', 'acme.lv', '[Domain]\nDomain: acme.lv\nStatus: free\n[Domain]\nDomain: acme.lv\nStatus: active\n'],
    ] as const) {
      const result = run(parser, ascii, text);
      expect([parser, result.outcome, result.registration], text).toEqual([parser, 'inconclusive', null]);
    }
  });

  it('does not let malformed, partial or extra lines slip past the strict patterns', () => {
    const conflicts: [string, string, string][] = [
      ['domreg-das', 'acme.lt', '% .lt registry DAS service\nDomain: acme.lt\nStatus: available\nStatus: pending delete\n'],
      ['internetstiftelsen', 'acme.se', 'state:            quarantine\nstate:            active pending\ndomain:           acme.se\n'],
      ['weare-ie', 'acme.ie', 'Domain Name: acme.ie\nDomain Name: other.ie extra\nRegistry Domain ID: 1-IEDR\nCreation Date: 2020-01-01T00:00:00Z\nRegistrar: Example\n'],
      ['nic-so', 'acme.so', 'Domain Name: acme.so\nThe queried object does not exist: No Object Found\nRegistry Expiry Date: 2030-01-01T00:00:00Z\nName Server: ns1.example.test\n'],
      ['nic-im', 'acme.im', 'Domain Name:\tacme.im\nThe domain acme.im was not found.\nName Server:ns1.example.test.\n'],
      ['identity-digital', 'acme.io', 'Domain not found.\nCreation Date: 2020-01-01T00:00:00Z\nRegistrar: Example\n'],
      ['eis', 'acme.ee', 'Domain:\nname: acme.ee\nstatus: Reserved\nstatus: ok\n\nEstonia .ee Top Level Domain WHOIS server\n'],
      ['eis', 'acme.ee', 'Domain:\nname: acme.ee\nstatus: Reserved\nregistered: 2020-01-01\n\nEstonia .ee Top Level Domain WHOIS server\n'],
      ['rnids', 'acme.rs', '%ERROR:103: Domain is not registered\n%ERROR:101: Invalid query\n'],
      ['registro-it', 'acme.it', 'Domain:             acme.it\nStatus:             AVAILABLE\nCreated:            2020-01-01 00:00:00\n'],
      ['nic-lv', 'acme.lv', '[Domain]\nDomain: acme.lv\nStatus: free\n\n[Nservers]\nNserver: ns1.example.test\n'],
      ['dns-belgium', 'acme.be', 'Domain:\tacme.be\nStatus:\tAVAILABLE\nRegistered:\tMon Jan 12 2015\n'],
    ];
    for (const [parser, ascii, text] of conflicts) {
      expect([parser, run(parser, ascii, text).reason.code], text).toEqual([parser, 'conflicting_reply']);
    }
    expect(run('isoc-il', 'acme.co.il', 'query:        other.co.il\n% No data was found to match the request criteria.\n').reason.code).toBe('identity_mismatch');
    expect(run('weare-ie', 'acme.ie', 'Domain Name: acme.ie/path\nRegistry Domain ID: 1-IEDR\nCreation Date: 2020-01-01T00:00:00Z\nRegistrar: Example\n').outcome).toBe('inconclusive');
    expect(run('channel-isles', 'acme.gg', 'Domain:\n     acme.gg\n\nDomain Status:\n     Active\n\nRegistration status:\n').outcome).toBe('inconclusive');
  });

  it('applies the same checks to malformed duplicates in the remaining special layouts', () => {
    for (const [parser, ascii, text] of [
      ['denic', 'acme.de', 'Domain: acme.de\nStatus: free\nStatus: connect pending\n'],
      ['denic', 'acme.de', 'Domain: acme.de\nStatus: free\nNserver: ns1.example.test\n'],
      ['cnnic', 'acme.cn', 'No matching record.\nRegistration Time: 2020-01-01 00:00:00\nExpiration Time: 2030-01-01 00:00:00\n'],
      ['jprs', 'acme.jp', 'No match!!\n[Name Server]                   ns1.example.test\n'],
      ['eurid', 'acme.eu', 'Domain: acme.eu\nStatus: AVAILABLE\nRegistrar:\n    Name: Example Registrar\n'],
      ['register-bg', 'acme.bg', 'DOMAIN NAME: acme.bg\nDOMAIN NAME: other.bg extra\nregistration status: available\n'],
      ['nic-lv', 'acme.lv', '[Domain]\nDomain: acme.lv\nStatus: free\nStatus:\n'],
      ['dns-lu', 'acme.lu', 'domainname:     acme.lu\ndomaintype:     FREE\nregistered:     2020-01-01\n'],
    ] as const) {
      expect([parser, run(parser, ascii, text).reason.code], text).toEqual([parser, 'conflicting_reply']);
    }
    const lu = run('dns-lu', 'acme.lu', '% WHOIS other.lu extra\n% No such domain\n');
    expect(lu.outcome).toBe('inconclusive');
    expect(run('dns-lu', 'acme.lu', '% WHOIS database in its entirety is protected\n% WHOIS acme.lu\n% No such domain\n').outcome).toBe('no_record');
  });

  it('matches only documented DNS-LU domaintype values', () => {
    expect(run('dns-lu', 'acme.lu', 'domainname:     acme.lu\ndomaintype:     FREE UNKNOWN STATE\n').reason.code).toBe('unknown_status');
    expect(run('dns-lu', 'acme.lu', 'domainname:     acme.lu\ndomaintype:     ACTIVE SOMETHING\n').reason.code).toBe('unknown_status');
    expect(run('dns-lu', 'acme.lu', 'domainname:     acme.lu\ndomaintype:     FREE ON HOLD\n').reason.code).toBe('unknown_status');
    expect(run('dns-lu', 'acme.lu', 'domainname:     acme.lu\ndomaintype:     ACTIVE ON HOLD\n').outcome).toBe('registered');
    expect(run('dns-lu', 'acme.lu', 'domainname:     acme.lu\ndomaintype:     RESERVED PENDING_DELETE\n').eligibility.status).toBe('reserved');
  });

  it('accepts the TRABIS negative only unquoted or with paired quotes', () => {
    expect(run('trabis', 'acme.tr', 'No match found for "acme.tr\n').outcome).toBe('inconclusive');
    expect(run('trabis', 'acme.tr', 'No match found for acme.tr"\n').outcome).toBe('inconclusive');
    expect(run('trabis', 'acme.tr', 'No match found for "acme.tr"\n').outcome).toBe('no_record');
    expect(run('trabis', 'acme.tr', 'No match found for acme.tr\n').outcome).toBe('no_record');
  });

  it('accepts whole-reply negatives only when nothing else is in the reply', () => {
    expect(run('channel-isles', 'acme.gg', 'NOT FOUND\r\nPlease try later\r\n').outcome).toBe('inconclusive');
    expect(run('aeda', 'acme.ae', 'No Data Found\nService note\n').outcome).toBe('inconclusive');
    expect(run('hkirc', 'acme.hk', 'The domain has not been registered. Try again\n').outcome).toBe('inconclusive');
    expect(run('amnic', 'acme.am', 'No match\n').outcome).toBe('inconclusive');
    expect(run('eis', 'acme.ee', '\nDomain not found\n').outcome).toBe('inconclusive');
    expect(run('tci', 'acme.ru', 'No entries found for the selected source(s).\n').outcome).toBe('inconclusive');
  });

  it('reports registry-stated reservations and restrictions on names without a registration', () => {
    const cases: [string, string, string, string, string][] = [
      ['internetstiftelsen', 'acme.se', 'state:            quarantine\ndomain:           acme.se\n', 'no_record', 'restricted'],
      ['dns-lu', 'acme.lu', 'domainname:     acme.lu\ndomaintype:     RESERVED\n', 'no_record', 'reserved'],
      ['eis', 'acme.ee', 'Domain:\nname:                  acme.ee\nstatus:                Blocked\n\nEstonia .ee Top Level Domain WHOIS server\n', 'no_record', 'restricted'],
      ['eis', 'acme.ee', 'Domain:\nname:                  acme.ee\nstatus:                AtAuction\n\nEstonia .ee Top Level Domain WHOIS server\n', 'no_record', 'restricted'],
      ['domreg-das', 'acme.lt', '% .lt registry DAS service\nDomain: acme.lt\nStatus: reserved\n', 'no_record', 'reserved'],
      ['registro-it', 'acme.it', 'Domain:             acme.it\nStatus:             UNASSIGNABLE\n', 'no_record', 'reserved'],
    ];
    for (const [parser, ascii, text, outcome, eligibility] of cases) {
      const result = run(parser, ascii, text);
      expect([parser, result.outcome, result.eligibility.status, result.registration], text).toEqual([parser, outcome, eligibility, null]);
      expect(result.eligibility.source, text).toBeTruthy();
    }
  });

  it('maps only documented states and leaves the rest inconclusive', () => {
    expect(run('eis', 'acme.ee', 'Domain:\nname:                  acme.ee\nstatus:                deleteCandidate\n\nEstonia .ee Top Level Domain WHOIS server\n').reason.code).toBe('unknown_status');
    expect(run('eis', 'acme.ee', '\nPolicy error: please study "Requirements for the registration of a Domain Name" of .ee domain regulations.\n\nEstonia .ee Top Level Domain WHOIS server\n').outcome).toBe('invalid');
    expect(run('domreg-das', 'acme.lt', '% .lt registry DAS service\nDomain: acme.lt\nStatus: pendingDelete\n').reason.code).toBe('unknown_status');
    expect(run('domreg-das', 'acme.lt', '% .lt registry DAS service\nDomain: acme.lt\nStatus: stopped\n').outcome).toBe('registered');
    expect(run('registro-it', 'acme.it', 'Domain:             acme.it\nStatus:             pendingDelete / redemptionPeriod\nCreated:            2020-01-01 00:00:00\n').outcome).toBe('registered');
    expect(run('registro-it', 'acme.it', 'Domain:             acme.it\nStatus:             deleted\n').reason.code).toBe('unknown_status');
    expect(run('dns-belgium', 'acme.be', 'Domain:\tacme.be\nStatus:\tQUARANTINE\n').reason.code).toBe('unknown_status');
    expect(run('dns-belgium', 'acme.be', 'Domain:\tacme.be\nStatus:\tREGISTERED\n').outcome).toBe('registered');
    expect(run('punktum', 'acme.dk', 'Domain:               acme.dk\nRegistered:           2001-01-01\nStatus:               Deactivated\n').outcome).toBe('registered');
    expect(run('register-bg', 'acme.bg', 'DOMAIN NAME: acme.bg (acme.bg)\nregistration status: on hold\n').reason.code).toBe('unknown_status');
    expect(run('nic-lv', 'acme.lv', '[Domain]\nDomain: acme.lv\nStatus: blocked\n').reason.code).toBe('unknown_status');
    expect(run('dns-belgium', 'acme.be', '% .be Whois Server 6.1\n% -1: Internal server error\n')).toMatchObject({ outcome: 'inconclusive', reason: { code: 'registry_error' }, retryable: true });
  });

  it('honors the pause HKIRC asks for', () => {
    const result = run('hkirc', 'acme.hk', 'Please maintain at least 30-second time before starting another enquiry.\n');
    expect([result.outcome, result.cooldownUntil]).toEqual(['rate_limited', '2026-10-05T12:00:30.000Z']);
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
