import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoverageListResponse, CoverageSummaryResponse, SuffixCoverageResponse } from '@domain-scout/contracts';
import { CoverageReader } from '../../src/core/ports.js';
import { loadRegistryData } from '../../src/registry/data.js';
import { RegistryHttpTransport } from '../../src/registry/rdap/http-transport.js';
import { RoutesService } from '../../src/registry/routes.service.js';
import { Database } from '../../src/storage/database.js';
import { createTestApp, type TestApp } from '../helpers.js';
import { FakeHttp, http } from './harness.js';

let t: TestApp;
let fake: FakeHttp;

beforeEach(async () => {
  fake = new FakeHttp();
  t = await createTestApp({ overrides: [{ provide: RegistryHttpTransport, useValue: fake }] });
});
afterEach(() => t.close());

const data = loadRegistryData();
const httpsBootstrapTlds = new Set(
  data.bootstrap.bootstrap.services.filter(([, urls]) => urls.some((u) => u.startsWith('https://'))).flatMap(([tlds]) => tlds),
);

const TESTED = [
  'ae', 'am', 'at', 'be', 'bg', 'ch', 'cn', 'co', 'co.il', 'co.uk', 'co.za', 'com', 'com.hk', 'com.sa', 'com.tr', 'de', 'dev', 'dk', 'ee', 'eu', 'gg', 'gl',
  'hk', 'hr', 'hu', 'ie', 'im', 'io', 'it', 'je', 'jp', 'la', 'li', 'lt', 'lu', 'lv', 'me', 'mx', 'nz', 'pt', 'rs', 'ru', 'sa', 'se', 'sh', 'si', 'sk', 'so',
  'tr', 'uk', 'us', 'vc', 'ws',
];

describe('coverage counts', () => {
  it('classifies every root TLD plus routed or tested second-level suffixes', async () => {
    const counts = t.app.get(CoverageReader).counts();
    const routed = new Set([...httpsBootstrapTlds, ...data.curatedRdap.routes.map((r) => r.tld), ...data.whois.routes.map((r) => r.tld)]);
    const root = new Set(data.rootTlds.tlds);
    const extra = new Set(
      [...data.whois.routes.map((r) => r.tld), ...data.fixtures.fixtures.map((f) => f.suffix), ...data.liveValidation.results.map((r) => r.suffix)].filter(
        (suffix): suffix is string => suffix !== null && !root.has(suffix),
      ),
    );
    expect(counts.tested + counts.discovered + counts.unsupported).toBe(data.rootTlds.count + extra.size);
    expect(counts.unsupported).toBe(data.rootTlds.tlds.filter((tld) => !routed.has(tld)).length);
    expect(counts.tested).toBe(TESTED.length);
  });

  it('routes every TLD in the original unsupported list except those left unsupported with a reason', () => {
    const routes = t.app.get(RoutesService);
    const requested = 'be se dk pt ie nz mx hk ru tr il ae sa gg so sh am ws la vc gl je im li lu ee lv lt sk hr rs gr ro bg hu co me us es it ch at za'.split(' ');
    const unsupported = requested.filter((tld) => routes.route(tld) === null);
    expect(unsupported).toEqual(['gr', 'ro', 'es', 'za']);
    const reasons = new Map(data.whois.withoutClassifier.map((entry) => [entry.tld, entry]));
    for (const tld of unsupported) {
      expect(reasons.get(tld)?.reason, tld).toBeTruthy();
      expect(reasons.get(tld)?.checkedAt, tld).toMatch(/^2026-10-05T/);
    }
  });

  it('serves the summary with dated bootstrap metadata and explicit limits', async () => {
    const res = await t.api.get('/coverage/summary').expect(200);
    const summary = CoverageSummaryResponse.parse(res.body).data;
    expect(summary.bootstrapPublishedAt).toBe('2026-09-30T23:00:03.000Z');
    expect(summary.limits.join(' ')).toContain('Bootstrap counts are not working-TLD counts');
    expect(summary.counts).toEqual(t.app.get(CoverageReader).counts());
  });
});

describe('coverage list and detail', () => {
  it('filters by status and pages with an opaque cursor', async () => {
    const tested = CoverageListResponse.parse((await t.api.get('/coverage?status=tested').expect(200)).body);
    expect(tested.data.map((c) => c.suffix)).toEqual(TESTED);
    expect(tested.total).toBe(TESTED.length);

    const first = CoverageListResponse.parse((await t.api.get('/coverage?limit=2&q=co').expect(200)).body);
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = CoverageListResponse.parse((await t.api.get(`/coverage?limit=2&q=co&cursor=${first.nextCursor}`).expect(200)).body);
    expect(second.data[0]!.suffix > first.data[1]!.suffix).toBe(true);
    expect(second.total).toBe(first.total);
  });

  it('describes a tested RDAP suffix and a curated WHOIS suffix', async () => {
    const si = SuffixCoverageResponse.parse((await t.api.get('/coverage/si').expect(200)).body).data;
    expect(si).toMatchObject({
      status: 'tested',
      protocol: 'rdap',
      endpoint: 'https://rdap.register.si/',
      registryId: 'register-si',
      routing: 'iana_bootstrap',
      fixtureTested: true,
    });
    const de = SuffixCoverageResponse.parse((await t.api.get('/coverage/.DE').expect(200)).body).data;
    expect(de).toMatchObject({ status: 'tested', protocol: 'whois', endpoint: 'whois.denic.de:43', routing: 'curated', liveValidatedAt: null });
    expect(de.notes).toContain('reconstructed');
    expect(de.notes).toContain('Live validation not run');
    expect(de.eligibilityNotes[0]!.source).toContain('denic.de');
  });

  it('describes a live-validated curated RDAP suffix', async () => {
    const ch = SuffixCoverageResponse.parse((await t.api.get('/coverage/ch').expect(200)).body).data;
    expect(ch).toMatchObject({
      status: 'tested',
      protocol: 'rdap',
      endpoint: 'https://rdap.nic.ch/',
      registryId: 'switch',
      routing: 'curated',
      fixtureTested: true,
    });
    expect(ch.liveValidatedAt).toMatch(/^2026-10-05T/);
    expect(ch.liveValidation).toEqual([expect.objectContaining({ expected: 'no_record', observed: 'no_record' })]);
    expect(ch.notes).toContain('not listed in the IANA bootstrap');
    expect(ch.notes).toContain('https://www.nic.ch/whois/rdap/');
  });

  it('describes a fixture-only ccTLD WHOIS suffix and its second-level registry routes honestly', async () => {
    const be = SuffixCoverageResponse.parse((await t.api.get('/coverage/be').expect(200)).body).data;
    expect(be).toMatchObject({ status: 'tested', protocol: 'whois', endpoint: 'whois.dns.be:43', registryId: 'dns-belgium', routing: 'curated', liveValidatedAt: null });
    expect(be.notes).toContain('reconstructed');
    expect(be.notes).toContain('port 43 was blocked');
    expect(be.notes).toContain('Second-level zones not routed: .ac.be');

    const coza = SuffixCoverageResponse.parse((await t.api.get('/coverage/co.za').expect(200)).body).data;
    expect(coza).toMatchObject({ tld: 'za', status: 'tested', endpoint: 'coza-whois.registry.net.za:43', registryId: 'zarc' });
    expect(coza.notes).not.toContain('Routed through');
    const orgza = SuffixCoverageResponse.parse((await t.api.get('/coverage/org.za').expect(200)).body).data;
    expect(orgza).toMatchObject({ status: 'discovered', endpoint: 'org-whois.registry.net.za:43', fixtureTested: false });

    const coil = SuffixCoverageResponse.parse((await t.api.get('/coverage/co.il').expect(200)).body).data;
    expect(coil).toMatchObject({ status: 'tested', endpoint: 'whois.isoc.org.il:43' });
    expect(coil.notes).toContain('Routed through the .il registry');
  });

  it('marks second-level zones a curated registry does not serve as unsupported', async () => {
    for (const suffix of ['gov.ie', 'ny.us', 'k12.ny.us', 'org.se', 'ac.za', 'gov.co']) {
      const row = SuffixCoverageResponse.parse((await t.api.get(`/coverage/${suffix}`).expect(200)).body).data;
      expect([suffix, row.status, row.endpoint]).toEqual([suffix, 'unsupported', null]);
    }
    const govie = SuffixCoverageResponse.parse((await t.api.get('/coverage/gov.ie').expect(200)).body).data;
    expect(govie.notes).toContain('does not cover the .gov.ie zone');
    const commx = SuffixCoverageResponse.parse((await t.api.get('/coverage/com.mx').expect(200)).body).data;
    expect(commx).toMatchObject({ status: 'discovered', endpoint: 'whois.mx:43' });
  });

  it('keeps unsupported suffixes explicit, with the reason', async () => {
    const za = SuffixCoverageResponse.parse((await t.api.get('/coverage/za').expect(200)).body).data;
    expect(za).toMatchObject({ status: 'unsupported', protocol: null, endpoint: null });
    expect(za.notes).toContain('IANA lists neither RDAP nor WHOIS');
    for (const [tld, text] of [
      ['es', 'authorized IP addresses'],
      ['gr', 'no port-43 WHOIS or RDAP service'],
      ['ro', 'domain hunting'],
    ]) {
      const row = SuffixCoverageResponse.parse((await t.api.get(`/coverage/${tld}`).expect(200)).body).data;
      expect([tld, row.status]).toEqual([tld, 'unsupported']);
      expect(row.notes, tld).toContain(text);
    }
    const kg = SuffixCoverageResponse.parse((await t.api.get('/coverage/kg').expect(200)).body).data;
    expect(kg.status).toBe('unsupported');
    expect(kg.notes).toContain('no usable https RDAP endpoint');
  });

  it('derives untested second-level suffixes from their TLD as discovered', async () => {
    const au = SuffixCoverageResponse.parse((await t.api.get('/coverage/com.au').expect(200)).body).data;
    expect(au).toMatchObject({ suffix: 'com.au', tld: 'au', status: 'discovered', fixtureTested: false });
    const ltd = SuffixCoverageResponse.parse((await t.api.get('/coverage/ltd.uk').expect(200)).body).data;
    expect(ltd.status).toBe('discovered');
  });

  it('rejects malformed cursors with 400', async () => {
    const cursor = Buffer.from(JSON.stringify({ after: {} })).toString('base64url');
    await t.api.get(`/coverage?cursor=${cursor}`).expect(400);
    await t.api.get('/coverage?cursor=not-a-cursor').expect(400);
  });

  it('answers 404 for names that are not ICANN suffixes', async () => {
    await t.api.get('/coverage/zzzz').expect(404);
    await t.api.get('/coverage/github.io').expect(404);
    await t.api.get('/coverage/acme.com').expect(404);
  });
});

describe('POST /coverage/refresh', () => {
  const live = (services: [string[], string[]][]) =>
    JSON.stringify({ version: '1.0', publication: '2026-10-05T00:00:00Z', description: 'test', services });

  it('fetches the IANA bootstrap only, without candidate names, and rebuilds routes', async () => {
    const services = data.bootstrap.bootstrap.services.map(([tlds, urls]) => [tlds, urls] as [string[], string[]]);
    services.push([['io'], ['https://rdap.example-io-registry.test/']]);
    fake.respond = () => http(200, live(services), { 'content-type': 'application/json', 'last-modified': 'Mon, 05 Oct 2026 00:00:00 GMT' });

    const res = await t.api.post('/coverage/refresh').expect(200);
    expect(fake.calls.map((c) => c.url)).toEqual(['https://data.iana.org/rdap/dns.json']);
    expect(CoverageSummaryResponse.parse(res.body).data.bootstrapPublishedAt).toBe('2026-10-05T00:00:00.000Z');

    // RDAP from the bootstrap now wins over the curated WHOIS route; WHOIS fixtures no longer count.
    const io = SuffixCoverageResponse.parse((await t.api.get('/coverage/io').expect(200)).body).data;
    expect(io).toMatchObject({
      protocol: 'rdap',
      endpoint: 'https://rdap.example-io-registry.test/',
      routing: 'iana_bootstrap',
      status: 'discovered',
      fixtureTested: false,
    });
    expect(t.app.get(RoutesService).bootstrapInfo().origin).toBe('refreshed');
  });

  it('prefers an IANA bootstrap entry over a curated RDAP route once IANA lists the TLD', async () => {
    const services = data.bootstrap.bootstrap.services.map(([tlds, urls]) => [tlds, urls] as [string[], string[]]);
    services.push([['ch'], ['https://rdap.example-ch-registry.test/']], [['co'], ['https://rdap.registry.co/co/']], [['ie'], ['https://rdap.example-ie-registry.test/']]);
    fake.respond = () => http(200, live(services));
    await t.api.post('/coverage/refresh').expect(200);
    // Reviewed second-level exclusions hold whichever endpoint wins.
    const routes = t.app.get(RoutesService);
    expect([routes.route('gov.co'), routes.route('gov.ie')]).toEqual([null, null]);
    expect(routes.route('com.co')).toMatchObject({ routing: 'iana_bootstrap', endpoint: 'https://rdap.registry.co/co/' });
    const govie = SuffixCoverageResponse.parse((await t.api.get('/coverage/gov.ie').expect(200)).body).data;
    expect(govie.status).toBe('unsupported');
    const ch = SuffixCoverageResponse.parse((await t.api.get('/coverage/ch').expect(200)).body).data;
    // RDAP fixtures still exercise the shared RDAP classifier; the live result belongs to the old endpoint.
    expect(ch).toMatchObject({ routing: 'iana_bootstrap', endpoint: 'https://rdap.example-ch-registry.test/', fixtureTested: true, liveValidatedAt: null });
    expect(t.app.get(RoutesService).route('li')).toMatchObject({ routing: 'curated', endpoint: 'https://rdap.nic.li/' });
  });

  it('skips unusable endpoints and keeps working after a restart from the stored snapshot', async () => {
    const services = data.bootstrap.bootstrap.services.map(([tlds, urls]) => [tlds, urls] as [string[], string[]]);
    services.push([['io'], ['https://']]);
    fake.respond = () => http(200, live(services));
    await t.api.post('/coverage/refresh').expect(200);
    const routes = t.app.get(RoutesService);
    expect(routes.route('io')).toMatchObject({ protocol: 'whois' });

    const db = t.app.get(Database);
    const restarted = new RoutesService(db, t.clock, fake);
    expect(restarted.bootstrapInfo()).toMatchObject({ origin: 'refreshed', publishedAt: '2026-10-05T00:00:00.000Z' });
    expect(restarted.route('com')).toMatchObject({ protocol: 'rdap' });
  });

  it('falls back to the bundled snapshot when the stored one cannot be used', async () => {
    const db = t.app.get(Database);
    db.run("INSERT INTO metadata (key, value_json, updated_at) VALUES ('registry.rdap_bootstrap', '{\"broken\":true}', '2026-10-05T00:00:00Z')");
    const restarted = new RoutesService(db, t.clock, fake);
    expect(restarted.bootstrapInfo().origin).toBe('bundled');
  });

  it('ignores a stored snapshot whose endpoints are unusable', async () => {
    const db = t.app.get(Database);
    const unusable = {
      source: 'https://data.iana.org/rdap/dns.json',
      fetchedAt: '2026-10-06T00:00:00Z',
      bootstrap: { ...data.bootstrap.bootstrap, publication: '2026-10-06T00:00:00Z', services: data.bootstrap.bootstrap.services.map(([tlds]) => [tlds, ['https://']]) },
    };
    db.run("INSERT INTO metadata (key, value_json, updated_at) VALUES ('registry.rdap_bootstrap', ?, '2026-10-06T00:00:00Z')", [JSON.stringify(unusable)]);
    const restarted = new RoutesService(db, t.clock, fake);
    expect(restarted.bootstrapInfo().origin).toBe('bundled');
    expect(restarted.route('com')).toMatchObject({ protocol: 'rdap' });
  });

  it('refuses a bootstrap older than the current one', async () => {
    const old = JSON.stringify({ ...data.bootstrap.bootstrap, publication: '2025-01-01T00:00:00Z' });
    fake.respond = () => http(200, old);
    const res = await t.api.post('/coverage/refresh').expect(503);
    expect(res.body.error.message).toContain('older than the current one');
  });

  it('keeps current routes when the fetch fails or the file shrinks suspiciously', async () => {
    fake.respond = () => http(500, 'oops');
    const failed = await t.api.post('/coverage/refresh').expect(503);
    expect(failed.body.error).toMatchObject({ code: 'unavailable', retryable: true, source: 'iana' });

    fake.respond = () => http(200, live([[['com'], ['https://rdap.verisign.com/com/v1/']]]));
    await t.api.post('/coverage/refresh').expect(503);
    expect(t.app.get(RoutesService).bootstrapInfo().origin).toBe('bundled');
    expect(t.app.get(RoutesService).route('si')).not.toBeNull();
  });
});
