import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CollectionEntryListResponse,
  CollectionListResponse,
  CollectionResponse,
  ExtensionPresetListResponse,
  SavedCriteriaListResponse,
  SavedCriteriaResponse,
} from '@domain-scout/contracts';
import { CollectionsModule } from '../../src/collections/collections.module.js';
import { InputPreviewer, JobSubmitter } from '../../src/core/ports.js';
import { Database } from '../../src/storage/database.js';
import { EvidenceRepository } from '../../src/storage/evidence.js';
import { createModuleApp, type ModuleApp } from '../evidence/harness.js';
import { EvidenceFixtures, FakeJobs, FakePreviewer } from '../evidence/fakes.js';
import { FakeClock } from '../../src/core/clock.js';

const T0 = '2026-10-05T12:00:00.000Z';
const minutes = (n: number) => new Date(Date.parse(T0) + n * 60_000).toISOString();

describe('collections, criteria and presets', () => {
  let t: ModuleApp;
  let jobs: FakeJobs;
  let fx: EvidenceFixtures;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const clock = new FakeClock(new Date(T0));
    jobs = new FakeJobs(clock);
    t = await createModuleApp({
      modules: [CollectionsModule],
      clock,
      providers: [
        { provide: InputPreviewer, useValue: new FakePreviewer() },
        { provide: JobSubmitter, useValue: jobs },
      ],
    });
    fx = new EvidenceFixtures(t.get(EvidenceRepository));
    http = request(t.app.getHttpServer());
  });
  afterAll(() => t.close());
  afterEach(() => vi.restoreAllMocks());

  it('creates, lists, renames and deletes collections while keeping evidence', async () => {
    const created = CollectionResponse.parse((await http.post('/api/v1/collections').send({ name: 'Ideas', notes: 'short' }).expect(201)).body).data;
    expect(created).toMatchObject({ name: 'Ideas', notes: 'short', entryCount: 0 });

    const add = await http
      .post(`/api/v1/collections/${created.id}/entries`)
      .send({ domains: ['Example.COM', 'example.com', 'bücher.de', 'bad..name', '', 'shop.co.uk', 'www.sub.example.com'], notes: 'n1' })
      .expect(200);
    expect(add.body.data.added).toBe(3);
    expect(add.body.data.existing).toBe(1);
    expect(add.body.data.rejected.map((r: { input: string }) => r.input)).toEqual(['bad..name', '', 'www.sub.example.com']);

    const again = await http.post(`/api/v1/collections/${created.id}/entries`).send({ domains: ['example.com'] }).expect(200);
    expect(again.body.data).toMatchObject({ added: 0, existing: 1 });

    fx.registry('example.com', 'registered', minutes(-60));
    const latestRegistry = fx.registry('example.com', 'no_record', minutes(-5));
    fx.confirmation('example.com', 'porkbun', 'unavailable', minutes(-30));
    const latestPorkbun = fx.confirmation('example.com', 'porkbun', 'available', minutes(-3));
    const dynadot = fx.confirmation('example.com', 'dynadot', 'unknown', minutes(-2));
    fx.offer({ providerId: 'porkbun', domain: null, suffix: 'com', registration: '10.00', at: minutes(-120) });
    const catalog = fx.offer({ providerId: 'porkbun', domain: null, suffix: 'com', registration: '11.00', at: minutes(-60) });
    const quote = fx.offer({ providerId: 'porkbun', domain: 'example.com', suffix: 'com', registration: '12.00', at: minutes(-2) });
    fx.offer({ providerId: 'porkbun', domain: null, suffix: 'net', registration: '9.00', at: minutes(-2) });

    const entries = CollectionEntryListResponse.parse((await http.get(`/api/v1/collections/${created.id}/entries`).expect(200)).body);
    expect(entries.total).toBe(3);
    const example = entries.data.find((e) => e.domain === 'example.com')!;
    expect(example.notes).toBe('n1');
    expect(example.registry?.id).toBe(latestRegistry);
    expect(example.registry?.freshness).toBe('fresh');
    expect(example.confirmations.map((c) => c.id).sort()).toEqual([latestPorkbun, dynadot].sort());
    expect(example.offers.map((o) => o.id).sort()).toEqual([catalog, quote].sort());
    expect(entries.data.find((e) => e.domain === 'xn--bcher-kva.de')?.unicode).toBe('bücher.de');
    expect(entries.data.find((e) => e.domain === 'shop.co.uk')?.registry).toBeNull();

    await http.patch(`/api/v1/collections/${created.id}/entries/EXAMPLE.com`).send({ notes: 'buy soon' }).expect(200);
    await http.patch(`/api/v1/collections/${created.id}/entries/missing.com`).send({ notes: 'x' }).expect(404);
    const removed = await http.post(`/api/v1/collections/${created.id}/entries/remove`).send({ domains: ['shop.co.uk', 'nothere.com'] }).expect(200);
    expect(removed.body.data.domains).toEqual(['shop.co.uk']);

    const patched = await http.patch(`/api/v1/collections/${created.id}`).send({ name: 'Shortlist', notes: null }).expect(200);
    expect(patched.body.data).toMatchObject({ name: 'Shortlist', notes: null, entryCount: 2 });
    const list = CollectionListResponse.parse((await http.get('/api/v1/collections?limit=10').expect(200)).body);
    expect(list.data.map((c) => c.id)).toContain(created.id);

    const db = t.get(Database);
    const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM observations')!.n;
    await http.delete(`/api/v1/collections/${created.id}`).expect(200);
    await http.get(`/api/v1/collections/${created.id}`).expect(404);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM observations')!.n).toBe(before);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM offers')!.n).toBe(4);
  });

  it('paginates collections with an opaque cursor', async () => {
    for (const name of ['a', 'b', 'c']) await http.post('/api/v1/collections').send({ name }).expect(201);
    const first = CollectionListResponse.parse((await http.get('/api/v1/collections?limit=2').expect(200)).body);
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = CollectionListResponse.parse(
      (await http.get(`/api/v1/collections?limit=2&cursor=${first.nextCursor}`).expect(200)).body,
    );
    expect(new Set([...first.data, ...second.data].map((c) => c.id)).size).toBe(first.total);
  });

  it('saves and restores criteria without submitting jobs or touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const body = {
      name: 'Short tech names',
      filter: { outcomes: ['no_record'], suffixes: ['io'], maxLength: 8 },
      extensions: ['io', 'dev'],
      providerIds: ['porkbun'],
      budget: { amount: '25.00', currency: 'USD' },
      generation: { roots: ['scout'], strategies: ['roots', 'affixes'] },
      input: 'scout\nscouty',
    };
    const created = SavedCriteriaResponse.parse((await http.post('/api/v1/criteria').send(body).expect(201)).body).data;
    expect(created.filter).toMatchObject({ outcomes: ['no_record'], sort: 'input', order: 'asc' });
    expect(created.generation?.rules.maxLength).toBe(15);

    const restored = SavedCriteriaResponse.parse((await http.get(`/api/v1/criteria/${created.id}`).expect(200)).body).data;
    expect(restored).toEqual(created);

    const replaced = SavedCriteriaResponse.parse(
      (await http.put(`/api/v1/criteria/${created.id}`).send({ name: 'Renamed' }).expect(200)).body,
    ).data;
    expect(replaced).toMatchObject({ name: 'Renamed', filter: null, extensions: [], budget: null, input: null });

    const minimal = SavedCriteriaResponse.parse((await http.post('/api/v1/criteria').send({ name: 'Bare' }).expect(201)).body).data;
    const list = SavedCriteriaListResponse.parse((await http.get('/api/v1/criteria?limit=1').expect(200)).body);
    expect(list.total).toBe(2);
    expect(list.data).toHaveLength(1);
    expect(list.nextCursor).not.toBeNull();

    await http.delete(`/api/v1/criteria/${minimal.id}`).expect(200);
    await http.get(`/api/v1/criteria/${minimal.id}`).expect(404);
    await http.post('/api/v1/criteria').send({ name: '' }).expect(400);

    expect(jobs.submitted).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lists built-in presets, saves user presets with UUID ids and refuses to delete built-ins', async () => {
    const before = ExtensionPresetListResponse.parse((await http.get('/api/v1/presets').expect(200)).body);
    const builtIn = before.data.filter((p) => p.builtIn);
    expect(builtIn.map((p) => p.id)).toEqual(['popular', 'europe']);
    for (const preset of builtIn) {
      expect(preset.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(preset.createdAt).toBeNull();
    }

    const saved = (await http.post('/api/v1/presets').send({ name: 'Mine', extensions: ['si', 'co.uk', 'si'] }).expect(201)).body.data;
    expect(saved).toMatchObject({ name: 'Mine', extensions: ['si', 'co.uk'], builtIn: false });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    await http.post('/api/v1/presets').send({ name: 'Bad', extensions: ['.COM'] }).expect(400);

    const after = ExtensionPresetListResponse.parse((await http.get('/api/v1/presets').expect(200)).body);
    expect(after.total).toBe(before.total! + 1);
    expect(after.data.at(-1)?.id).toBe(saved.id);

    await http.delete(`/api/v1/presets/${builtIn[0]!.id}`).expect(409);
    await http.delete(`/api/v1/presets/${saved.id}`).expect(200);
    await http.delete(`/api/v1/presets/${saved.id}`).expect(404);
  });
});

describe('presets without the registry module', () => {
  it('fall back to a small inline built-in list', async () => {
    const t = await createModuleApp({ modules: [CollectionsModule] });
    try {
      const list = ExtensionPresetListResponse.parse((await request(t.app.getHttpServer()).get('/api/v1/presets').expect(200)).body);
      expect(list.data.length).toBeGreaterThan(0);
      expect(list.data.every((p) => p.builtIn && p.createdAt === null)).toBe(true);
    } finally {
      await t.close();
    }
  });
});

describe('shortlists across sessions (S02)', () => {
  it('reopening the app on the same data directory keeps entries, notes, evidence and offers', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'domain-scout-s02-'));
    const domain = 'qzvkxmwplrtnbjhdgfcsyaeu.com';
    const boot = () =>
      createModuleApp({
        modules: [CollectionsModule],
        clock: new FakeClock(new Date(T0)),
        dataDir,
        providers: [{ provide: InputPreviewer, useValue: new FakePreviewer() }],
      });
    try {
      const first = await boot();
      const fx = new EvidenceFixtures(first.get(EvidenceRepository));
      const http = request(first.app.getHttpServer());
      const created = CollectionResponse.parse((await http.post('/api/v1/collections').send({ name: 'Keep', notes: 'launch' }).expect(201)).body).data;
      await http.post(`/api/v1/collections/${created.id}/entries`).send({ domains: [domain, 'example.com'], notes: 'call registrar' }).expect(200);
      const registry = fx.registry(domain, 'no_record', minutes(-5));
      const confirmation = fx.confirmation(domain, 'porkbun', 'available', minutes(-3));
      const catalog = fx.offer({ providerId: 'porkbun', domain: null, suffix: 'com', registration: '11.08', renewal: '12.08', at: minutes(-60), sourceUrl: 'https://porkbun.test/pricing' });
      const quote = fx.offer({ providerId: 'porkbun', domain, suffix: 'com', registration: '9.73', at: minutes(-2) });
      const before = CollectionEntryListResponse.parse((await http.get(`/api/v1/collections/${created.id}/entries`).expect(200)).body);
      await first.close();

      const second = await boot();
      try {
        const http2 = request(second.app.getHttpServer());
        const collection = CollectionResponse.parse((await http2.get(`/api/v1/collections/${created.id}`).expect(200)).body).data;
        expect(collection).toMatchObject({ name: 'Keep', notes: 'launch', entryCount: 2 });
        const after = CollectionEntryListResponse.parse((await http2.get(`/api/v1/collections/${created.id}/entries`).expect(200)).body);
        expect(after).toEqual(before);
        const entry = after.data.find((e) => e.domain === domain)!;
        expect(entry.notes).toBe('call registrar');
        expect(entry.registry).toMatchObject({ id: registry, outcome: 'no_record', checkedAt: minutes(-5) });
        expect(entry.confirmations.map((c) => [c.id, c.providerId, c.status, c.checkedAt])).toEqual([[confirmation, 'porkbun', 'available', minutes(-3)]]);
        expect(entry.offers.map((o) => o.id).sort()).toEqual([catalog, quote].sort());
        expect(entry.offers.find((o) => o.id === catalog)).toMatchObject({ registration: { amount: '11.08' }, renewal: { amount: '12.08' }, source: { url: 'https://porkbun.test/pricing' } });
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
