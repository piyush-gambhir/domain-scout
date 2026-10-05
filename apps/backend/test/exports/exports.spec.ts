import request from 'supertest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExportListResponse, ExportResponse, type JobItem, type RegistryObservation } from '@domain-scout/contracts';
import { CollectionsModule } from '../../src/collections/collections.module.js';
import { FakeClock } from '../../src/core/clock.js';
import { InputPreviewer, JobResults } from '../../src/core/ports.js';
import { ExportsModule } from '../../src/exports/exports.module.js';
import { csvCell } from '../../src/exports/rows.js';
import { EvidenceRepository } from '../../src/storage/evidence.js';
import { createModuleApp, type ModuleApp } from '../evidence/harness.js';
import { EvidenceFixtures, FakePreviewer, FakeResults } from '../evidence/fakes.js';

const T0 = '2026-10-05T12:00:00.000Z';

function registry(domain: string, outcome: string): RegistryObservation {
  return {
    id: randomUUID(),
    domain,
    unicode: domain,
    suffix: domain.slice(domain.indexOf('.') + 1),
    source: { registryId: 'reg', protocol: 'rdap', destination: 'https://rdap.test/', routing: 'iana_bootstrap' },
    outcome: outcome as RegistryObservation['outcome'],
    eligibility: { status: 'unknown', source: null, scope: null },
    reason: { code: outcome, message: `Registry said ${outcome}` },
    checkedAt: '2026-10-05T11:55:00.000Z',
    staleAt: '2026-10-05T12:10:00.000Z',
    freshness: 'fresh',
    reused: false,
    httpStatus: 200,
    retryAt: null,
    matchedName: null,
    parserVersion: 't',
    registration: null,
    hasRawDiagnostics: false,
  };
}

function item(jobId: string, domain: string, outcome: string): JobItem {
  return {
    id: randomUUID(),
    jobId,
    subject: domain,
    unicode: domain,
    suffix: domain.slice(domain.indexOf('.') + 1),
    operation: 'registry',
    target: null,
    source: null,
    state: 'finished',
    attempts: 1,
    outcome,
    resolved: ['registered', 'no_record'].includes(outcome),
    error: null,
    retryAt: null,
    startedAt: T0,
    finishedAt: T0,
    evidence: { registry: registry(domain, outcome), confirmation: null, offers: [], nameCheck: null, diagnostic: null, listing: null },
    bestPrice: outcome === 'no_record' ? { providerId: 'porkbun', amount: '10.37', currency: 'USD', kind: 'published', years: 1 } : null,
    collectionIds: [],
  };
}

/** Names in a TXT export (comment lines removed). */
const txtNames = (body: string) => body.split('\n').filter((l) => l && !l.startsWith('#'));
/** Data rows of a CSV export, as arrays of raw cells (no quoted commas in these fixtures). */
const csvRows = (body: string) => body.trim().split('\r\n').slice(1).map((l) => l.split(','));

describe('exports', () => {
  let t: ModuleApp;
  let results: FakeResults;
  let fx: EvidenceFixtures;
  let http: ReturnType<typeof request>;
  const jobId = randomUUID();

  beforeAll(async () => {
    results = new FakeResults();
    t = await createModuleApp({
      modules: [ExportsModule, CollectionsModule],
      clock: new FakeClock(new Date(T0)),
      providers: [
        { provide: InputPreviewer, useValue: new FakePreviewer() },
        { provide: JobResults, useValue: results },
      ],
    });
    fx = new EvidenceFixtures(t.get(EvidenceRepository));
    http = request(t.app.getHttpServer());
    results.items.set(jobId, [
      item(jobId, 'alpha.com', 'registered'),
      item(jobId, 'bravo.com', 'no_record'),
      item(jobId, 'charlie.io', 'no_record'),
      item(jobId, 'delta.com', 'rate_limited'),
      item(jobId, 'echo.com', 'no_record'),
      item(jobId, 'foxtrot.dev', 'inconclusive'),
    ]);
  });
  afterAll(() => t.close());

  async function exportOf(body: Record<string, unknown>) {
    const created = ExportResponse.parse((await http.post('/api/v1/exports').send(body).expect(201)).body).data;
    const file = await http.get(`/api/v1/exports/${created.id}/download`).buffer(true).parse((res, cb) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
      res.on('end', () => cb(null, data));
    });
    return { meta: created, body: file.body as string, headers: file.headers };
  }

  it('exports exactly the names in each scope (scenario 8)', async () => {
    const items = results.items.get(jobId)!;

    const filtered = await exportOf({ format: 'csv', scope: { kind: 'filter', jobId, filter: { outcomes: ['no_record'] } } });
    expect(csvRows(filtered.body).map((r) => r[0])).toEqual(['bravo.com', 'charlie.io', 'echo.com']);
    expect(filtered.meta.itemCount).toBe(3);

    const selected = await exportOf({ format: 'txt', scope: { kind: 'selection', itemIds: [items[3]!.id, items[0]!.id] } });
    expect(txtNames(selected.body)).toEqual(['delta.com', 'alpha.com']);

    const job = await exportOf({ format: 'json', scope: { kind: 'job', jobId } });
    const doc = JSON.parse(job.body);
    expect(doc.items.map((i: { domain: string }) => i.domain)).toEqual(items.map((i) => i.subject));
    expect(doc.contractVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(doc.resolved).toMatchObject({ kind: 'job', itemIds: items.map((i) => i.id) });
    expect(doc.items[1]).toMatchObject({ outcome: 'no_record', priceKind: 'published', registration: '10.37', currency: 'USD' });
    expect(doc.items[3]).toMatchObject({ outcome: 'rate_limited', registration: null, priceKind: null });

    const collection = (await http.post('/api/v1/collections').send({ name: 'Picks' }).expect(201)).body.data;
    await http.post(`/api/v1/collections/${collection.id}/entries`).send({ domains: ['bravo.com', 'xray.com'] }).expect(200);
    fx.registry('bravo.com', 'no_record', '2026-10-05T11:58:00.000Z');
    const shortlist = await exportOf({ format: 'csv', scope: { kind: 'collection', collectionId: collection.id }, fields: ['domain', 'outcome', 'reason'] });
    expect(csvRows(shortlist.body).map((r) => r.slice(0, 3))).toEqual([
      ['bravo.com', 'no_record', 'Registry said no_record'],
      ['xray.com', '', 'No registry evidence retained'],
    ]);

    const listed = await exportOf({ format: 'txt', scope: { kind: 'domains', domains: ['bravo.com', 'BRAVO.com', 'not a domain'] } });
    expect(txtNames(listed.body)).toEqual(['bravo.com']);
    expect(listed.meta.warnings.join(' ')).toContain('not a domain');

    fx.confirmation('zulu.com', 'porkbun', 'available', '2026-10-05T11:59:00.000Z');
    const all = await exportOf({ format: 'txt', scope: { kind: 'all' } });
    expect(txtNames(all.body)).toEqual(['bravo.com', 'zulu.com']);
  });

  it('keeps an export stable after its job changes', async () => {
    const first = await exportOf({ format: 'csv', scope: { kind: 'filter', jobId, filter: { outcomes: ['no_record'] } } });
    const items = results.items.get(jobId)!;
    items.push(item(jobId, 'golf.com', 'no_record'));
    items[1] = { ...items[1]!, outcome: 'registered' };

    const again = await http.get(`/api/v1/exports/${first.meta.id}/download`).expect(200);
    expect(again.text).toBe(first.body);
    const metadata = ExportResponse.parse((await http.get(`/api/v1/exports/${first.meta.id}`).expect(200)).body).data;
    expect(metadata.itemCount).toBe(3);

    const fresh = await exportOf({ format: 'csv', scope: { kind: 'filter', jobId, filter: { outcomes: ['no_record'] } } });
    expect(csvRows(fresh.body).map((r) => r[0])).toEqual(['charlie.io', 'echo.com', 'golf.com']);
    items.pop();
    items[1] = { ...items[1]!, outcome: 'no_record' };
  });

  it('labels TXT lists as uncertain candidates and filters candidates on request', async () => {
    const collection = (await http.post('/api/v1/collections').send({ name: 'TXT' }).expect(201)).body.data;
    await http.post(`/api/v1/collections/${collection.id}/entries`).send({ domains: ['hotel.com', 'india.com', 'juliet.com'] }).expect(200);
    fx.registry('hotel.com', 'no_record', '2026-10-05T11:50:00.000Z');
    fx.registry('india.com', 'registered', '2026-10-05T11:50:00.000Z');
    fx.confirmation('india.com', 'porkbun', 'available', '2026-10-05T11:51:00.000Z');
    fx.registry('juliet.com', 'rate_limited', '2026-10-05T11:50:00.000Z');

    const all = await exportOf({ format: 'txt', scope: { kind: 'collection', collectionId: collection.id } });
    const header = all.body.split('\n').filter((l) => l.startsWith('#')).join('\n');
    expect(header).toContain('not a list of guaranteed registrable names');
    expect(header).toContain('no registration record');
    expect(txtNames(all.body)).toEqual(['hotel.com', 'india.com', 'juliet.com']);
    expect(all.headers['content-type']).toBe('text/plain; charset=utf-8');

    const candidates = await exportOf({ format: 'txt', candidatesOnly: true, scope: { kind: 'collection', collectionId: collection.id } });
    expect(txtNames(candidates.body)).toEqual(['hotel.com', 'india.com']);
    expect(candidates.body).toContain('# Kept only names with no registry record or a positive provider confirmation');
  });

  it('escapes spreadsheet formulas and only includes notes when asked', async () => {
    const collection = (await http.post('/api/v1/collections').send({ name: 'Notes' }).expect(201)).body.data;
    await http
      .post(`/api/v1/collections/${collection.id}/entries`)
      .send({ domains: ['kilo.com'], notes: '=HYPERLINK("http://evil.test","x")' })
      .expect(200);

    const without = await exportOf({ format: 'csv', scope: { kind: 'collection', collectionId: collection.id }, fields: ['domain', 'notes'] });
    expect(without.body).not.toContain('HYPERLINK');
    expect(without.meta.fields).not.toContain('notes');
    expect(without.meta.warnings.join(' ')).toContain('includeNotes');
    expect(without.meta.fields).toEqual(['domain', 'outcome', 'checkedAt', 'source', 'priceKind']);

    const withNotes = await exportOf({ format: 'csv', includeNotes: true, scope: { kind: 'collection', collectionId: collection.id } });
    expect(withNotes.body).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")"`);
    expect(withNotes.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(withNotes.headers['content-disposition']).toMatch(/^attachment; filename="domain-scout-export-\d{8}T\d{6}Z\.csv"$/);

    const json = await exportOf({ format: 'json', includeNotes: true, scope: { kind: 'domains', domains: ['kilo.com'] } });
    expect(JSON.parse(json.body).items[0].notes).toBe('=HYPERLINK("http://evil.test","x")');

    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
  });

  it('keeps the evidence of non-registry job items (name checks, confirmations)', async () => {
    const otherJob = randomUUID();
    const check = item(otherJob, 'scoutly', 'not_found');
    check.operation = 'name_check';
    check.target = 'npm';
    check.suffix = null;
    check.evidence = {
      registry: null,
      confirmation: null,
      offers: [],
      nameCheck: {
        id: randomUUID(),
        name: 'scoutly',
        service: 'npm',
        namespace: 'npm package name',
        outcome: 'not_found',
        destination: 'registry.npmjs.org',
        httpStatus: 404,
        checkedAt: '2026-10-05T11:58:00.000Z',
        staleAt: '2026-10-05T12:13:00.000Z',
        freshness: 'fresh',
        reason: { code: 'not_found', message: 'npm returned no public record' },
        detail: null,
      },
      diagnostic: null,
      listing: null,
    };
    const confirm = item(otherJob, 'lima.com', 'available');
    confirm.operation = 'provider_check';
    confirm.target = 'porkbun';
    confirm.evidence = {
      ...confirm.evidence,
      registry: null,
      confirmation: {
        id: randomUUID(),
        providerId: 'porkbun',
        domain: 'lima.com',
        status: 'available',
        premium: null,
        checkedAt: '2026-10-05T11:57:00.000Z',
        staleAt: '2026-10-05T12:12:00.000Z',
        freshness: 'fresh',
        destination: 'api.porkbun.com',
        reason: { code: 'available', message: 'Provider reports the name as available' },
      },
    };
    results.items.set(otherJob, [check, confirm]);

    const json = JSON.parse((await exportOf({ format: 'json', scope: { kind: 'job', jobId: otherJob } })).body);
    expect(json.items[0]).toMatchObject({ domain: 'scoutly', outcome: 'not_found', checkedAt: '2026-10-05T11:58:00.000Z', freshness: 'fresh', source: 'registry.npmjs.org' });
    expect(json.items[1]).toMatchObject({ domain: 'lima.com', outcome: 'available', checkedAt: '2026-10-05T11:57:00.000Z', source: 'api.porkbun.com', confirmation: 'porkbun:available' });
    expect(json.resolved.evidenceIds.other).toEqual([check.evidence.nameCheck!.id]);

    const snapshot = (await http.post('/api/v1/snapshots').send({ title: 'Checks', scope: { kind: 'job', jobId: otherJob } }).expect(201)).body.data;
    const html = (await http.get(`/api/v1/snapshots/${snapshot.id}/download`).expect(200)).text;
    expect(html).toContain('Other checks');
    expect(html).toContain('npm (npm package name)');
    expect(html).toContain('not found');
  });

  it('lists, reads and deletes exports with their files', async () => {
    const created = await exportOf({ format: 'json', scope: { kind: 'domains', domains: ['bravo.com'] } });
    const list = ExportListResponse.parse((await http.get('/api/v1/exports?limit=2').expect(200)).body);
    expect(list.data).toHaveLength(2);
    expect(list.total).toBeGreaterThan(2);
    expect(list.nextCursor).not.toBeNull();
    expect(created.meta.downloadPath).toBe(`/api/v1/exports/${created.meta.id}/download`);
    expect(created.headers['content-type']).toBe('application/json; charset=utf-8');

    const file = join(t.config.dataDir, 'artifacts', `${created.meta.id}.json`);
    expect(existsSync(file)).toBe(true);
    await http.delete(`/api/v1/exports/${created.meta.id}`).expect(200);
    expect(existsSync(file)).toBe(false);
    await http.get(`/api/v1/exports/${created.meta.id}`).expect(404);
    await http.get(`/api/v1/exports/${created.meta.id}/download`).expect(404);
    await http.post('/api/v1/exports').send({ format: 'csv', scope: { kind: 'collection', collectionId: randomUUID() } }).expect(404);
  });
});
