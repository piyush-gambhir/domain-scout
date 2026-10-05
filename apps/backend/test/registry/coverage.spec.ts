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
const bootstrapTlds = new Set(data.bootstrap.bootstrap.services.flatMap(([tlds]) => tlds));

describe('coverage counts', () => {
  it('classifies every root TLD plus tested second-level suffixes', async () => {
    const counts = t.app.get(CoverageReader).counts();
    const whoisOnly = data.whois.routes.filter((r) => !bootstrapTlds.has(r.tld)).length;
    const httpOnly = data.bootstrap.bootstrap.services.filter(([, urls]) => !urls.some((u) => u.startsWith('https://'))).flatMap(([tlds]) => tlds).length;
    expect(counts.tested + counts.discovered + counts.unsupported).toBe(data.rootTlds.count + 1); // + co.uk
    expect(counts.unsupported).toBe(data.rootTlds.count - bootstrapTlds.size - whoisOnly + httpOnly);
    expect(counts.tested).toBe(10);
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
    expect(tested.data.map((c) => c.suffix)).toEqual(['cn', 'co.uk', 'com', 'de', 'dev', 'eu', 'io', 'jp', 'si', 'uk']);
    expect(tested.total).toBe(10);

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

  it('keeps unsupported suffixes explicit, with the reason', async () => {
    const za = SuffixCoverageResponse.parse((await t.api.get('/coverage/za').expect(200)).body).data;
    expect(za).toMatchObject({ status: 'unsupported', protocol: null, endpoint: null });
    expect(za.notes).toContain('IANA lists neither RDAP nor WHOIS');
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
