import request from 'supertest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SnapshotListResponse, SnapshotPreviewResponse, SnapshotResponse } from '@domain-scout/contracts';
import { CollectionsModule } from '../../src/collections/collections.module.js';
import { FakeClock } from '../../src/core/clock.js';
import { InputPreviewer } from '../../src/core/ports.js';
import { ExportsModule } from '../../src/exports/exports.module.js';
import { EvidenceRepository } from '../../src/storage/evidence.js';
import { createModuleApp, type ModuleApp } from '../evidence/harness.js';
import { EvidenceFixtures, FakePreviewer } from '../evidence/fakes.js';

const T0 = '2026-10-05T12:00:00.000Z';
const NOTE = 'Private: call broker <script>alert("note")</script>';
const SECRET_URL = 'https://api.provider.test/prices?apikey=SECRET-123';
const RAW_SECRET = 'RAW-SECRET-456';

describe('snapshots', () => {
  let t: ModuleApp;
  let http: ReturnType<typeof request>;
  let collectionId: string;

  beforeAll(async () => {
    t = await createModuleApp({
      modules: [ExportsModule, CollectionsModule],
      clock: new FakeClock(new Date(T0)),
      providers: [{ provide: InputPreviewer, useValue: new FakePreviewer() }],
    });
    http = request(t.app.getHttpServer());
    const fx = new EvidenceFixtures(t.get(EvidenceRepository));
    fx.registry('alpha.com', 'no_record', '2026-10-05T11:30:00.000Z', {
      reason: 'No match <img src=x onerror=alert(1)>',
      raw: `{"token":"${RAW_SECRET}"}`,
    });
    fx.registry('bravo.com', 'registered', '2026-10-05T11:59:00.000Z', {
      registration: {
        registrar: 'Example Registrar',
        createdAt: '2001-01-01T00:00:00.000Z',
        updatedAt: null,
        expiresAt: '2027-01-01T00:00:00.000Z',
        statuses: ['clientTransferProhibited'],
        nameservers: ['ns1.example.net'],
        dnssec: false,
      },
    });
    fx.confirmation('alpha.com', 'porkbun', 'available', '2026-10-05T11:40:00.000Z');
    fx.offer({ providerId: 'porkbun', domain: null, suffix: 'com', registration: '10.37', renewal: '11.08', at: '2026-10-05T06:00:00.000Z', sourceUrl: SECRET_URL });
    fx.offer({ providerId: 'porkbun', domain: 'alpha.com', suffix: 'com', registration: null, at: '2026-10-05T11:41:00.000Z' });
    collectionId = (await http.post('/api/v1/collections').send({ name: 'Share' }).expect(201)).body.data.id;
    await http.post(`/api/v1/collections/${collectionId}/entries`).send({ domains: ['alpha.com', 'bravo.com'], notes: NOTE }).expect(200);
  });
  afterAll(() => t.close());

  const scope = () => ({ kind: 'collection', collectionId });

  it('previews contents before saving, without notes by default', async () => {
    const preview = SnapshotPreviewResponse.parse(
      (await http.post('/api/v1/snapshots/preview').send({ title: 'Picks', scope: scope() }).expect(200)).body,
    ).data;
    expect(preview).toMatchObject({ itemCount: 2, includesNotes: false });
    expect(preview.fields).toEqual(['domain', 'unicode', 'suffix', 'registry', 'confirmations', 'registration', 'prices']);
    expect(JSON.stringify(preview.sample)).not.toContain('Private');
  });

  it('writes self-contained, escaped HTML and JSON with no scripts, credentials or private notes', async () => {
    const snapshot = SnapshotResponse.parse(
      (await http.post('/api/v1/snapshots').send({ title: 'Picks <b>for</b> review', scope: scope() }).expect(201)).body,
    ).data;
    expect(snapshot).toMatchObject({ itemCount: 2, include: { evidence: true, prices: true, registration: true, notes: false } });

    const html = await http.get(snapshot.htmlPath).expect(200);
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(html.headers['content-disposition']).toMatch(/^attachment; filename="domain-scout-snapshot-\d{8}T\d{6}Z\.html"$/);
    const body = html.text;

    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/<[a-z][^>]*\s(src|href|action|srcset|on[a-z]+)=/i);
    expect(body).not.toMatch(/url\(|@import/i);
    expect(body).toContain(`Content-Security-Policy" content="default-src 'none'`);
    expect(body).toContain('Picks &lt;b&gt;for&lt;/b&gt; review');
    expect(body).toContain('No match &lt;img src=x onerror=alert(1)&gt;');

    expect(body).not.toContain('Private');
    expect(body).not.toContain('SECRET-123');
    expect(body).not.toContain(RAW_SECRET);

    expect(body).toContain('No registry record');
    expect(body).not.toMatch(/>\s*Available\s*</);
    expect(body).toContain('2026-10-05T11:30:00.000Z');
    expect(body).toContain('stale at snapshot creation');
    expect(body).toContain('Published price');
    expect(body).toContain('Exact-name quote');
    expect(body).toContain('Example Registrar');
    expect(body).toContain('not a list of guaranteed registrable names');

    const json = await http.get(`/api/v1/snapshots/${snapshot.id}/download?format=json`).expect(200);
    expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(json.text).not.toContain('Private');
    expect(json.text).not.toContain('SECRET-123');
    expect(json.text).not.toContain(RAW_SECRET);
    const doc = JSON.parse(json.text);
    expect(doc.contractVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(doc.resolved.domains).toEqual(['alpha.com', 'bravo.com']);
    expect(doc.items[0]).not.toHaveProperty('notes');
    expect(doc.items[0].registry).toMatchObject({ outcome: 'no_record', checkedAt: '2026-10-05T11:30:00.000Z', freshnessAtCreation: 'stale' });
    expect(doc.items[0].prices.map((p: { kind: string; registration: string | null }) => [p.kind, p.registration])).toEqual([
      ['exact_quote', null],
      ['published', '10.37'],
    ]);
  });

  it('includes escaped notes only when selected', async () => {
    const snapshot = SnapshotResponse.parse(
      (await http.post('/api/v1/snapshots').send({ title: 'With notes', scope: scope(), include: { notes: true, prices: false } }).expect(201)).body,
    ).data;
    const html = (await http.get(`/api/v1/snapshots/${snapshot.id}/download`).expect(200)).text;
    expect(html).toContain('Private: call broker &lt;script&gt;alert(&quot;note&quot;)&lt;/script&gt;');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('Published price');
    const doc = JSON.parse((await http.get(`/api/v1/snapshots/${snapshot.id}/download?format=json`).expect(200)).text);
    expect(doc.items[0].notes).toBe(NOTE);
    expect(doc.items[0]).not.toHaveProperty('prices');
  });

  it('lists and deletes snapshots with both files', async () => {
    const list = SnapshotListResponse.parse((await http.get('/api/v1/snapshots').expect(200)).body);
    expect(list.total).toBe(2);
    const target = list.data[0]!;
    const htmlFile = join(t.config.dataDir, 'artifacts', `${target.id}.html`);
    const jsonFile = join(t.config.dataDir, 'artifacts', `${target.id}.json`);
    expect(existsSync(htmlFile) && existsSync(jsonFile)).toBe(true);
    await http.delete(`/api/v1/snapshots/${target.id}`).expect(200);
    expect(existsSync(htmlFile) || existsSync(jsonFile)).toBe(false);
    await http.get(`/api/v1/snapshots/${target.id}`).expect(404);
  });
});
