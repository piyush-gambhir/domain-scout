import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataDeleteResponse, DataInventoryResponse } from '@domain-scout/contracts';
import { EventsService } from '../../src/events/events.service.js';
import { Database } from '../../src/storage/database.js';
import { createTestApp, type TestApp } from '../helpers.js';
import { count, seedItem, seedJob, seedObservation } from './seed.js';

const OLD = '2026-01-01T00:00:00.000Z';
const NEW = '2026-10-01T00:00:00.000Z';
const CUTOFF = '2026-06-01T00:00:00Z';
const counters = { total: 1, pending: 0, running: 0, finished: 1, interrupted: 0, resolved: 1, unresolved: 0, outcomes: {} };

describe('data inventory and scoped deletion', () => {
  let t: TestApp;
  let db: Database;
  let events: EventsService;
  const ids = {
    doneJob: randomUUID(),
    runningJob: randomUUID(),
    oldRegistry: randomUUID(),
    newRegistry: randomUUID(),
    nameCheck: randomUUID(),
    confirmation: randomUUID(),
    collectionA: randomUUID(),
    collectionB: randomUUID(),
    watch: randomUUID(),
  };

  beforeEach(async () => {
    t = await createTestApp();
    db = t.app.get(Database);
    events = t.app.get(EventsService);
    db.transaction(() => {
      seedObservation(db, { id: ids.oldRegistry, kind: 'registry', subject: 'old.com', observedAt: OLD, raw: true });
      seedObservation(db, { id: ids.newRegistry, kind: 'registry', subject: 'new.com', observedAt: NEW });
      seedObservation(db, { id: ids.nameCheck, kind: 'name_check', subject: 'old', observedAt: OLD });
      seedObservation(db, { id: ids.confirmation, kind: 'confirmation', subject: 'old.com', observedAt: OLD });
      db.run(
        `INSERT INTO watches (id, name, domains_json, interval_minutes, state, created_at, updated_at, last_job_id)
         VALUES (?, 'w', '["old.com"]', 60, 'active', ?, ?, ?)`,
        [ids.watch, OLD, OLD, ids.doneJob],
      );
      seedJob(db, { id: ids.doneJob, state: 'completed', createdAt: OLD });
      seedJob(db, { id: ids.runningJob, state: 'running', createdAt: OLD });
      db.run("UPDATE jobs SET watch_id = ? WHERE id = ?", [ids.watch, ids.runningJob]);
      seedItem(db, { id: randomUUID(), jobId: ids.doneJob, seq: 1, subject: 'old.com', state: 'finished', observationId: ids.oldRegistry });
      seedItem(db, { id: randomUUID(), jobId: ids.runningJob, seq: 1, subject: 'new.com', state: 'pending' });
      db.run("INSERT INTO watch_runs (id, watch_id, status, scheduled_for, job_id) VALUES (?, ?, 'done', ?, ?)", [randomUUID(), ids.watch, OLD, ids.doneJob]);
      db.run(
        `INSERT INTO notices (id, watch_id, domain, type, summary, before_json, after_json, dedupe_key, created_at)
         VALUES (?, ?, 'old.com', 'changed', 's', '{}', '{}', 'k', ?)`,
        [randomUUID(), ids.watch, OLD],
      );
      for (const id of [ids.collectionA, ids.collectionB]) {
        db.run("INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, 'c', ?, ?)", [id, OLD, OLD]);
        db.run("INSERT INTO collection_entries (id, collection_id, domain, unicode, added_at) VALUES (?, ?, 'old.com', 'old.com', ?)", [randomUUID(), id, OLD]);
      }
      const fetchId = randomUUID();
      db.run("INSERT INTO catalog_fetches (id, provider_id, status, fetched_at, source) VALUES (?, 'porkbun', 'ok', ?, 'test')", [fetchId, OLD]);
      db.run(
        `INSERT INTO offers (id, provider_id, domain, suffix, purchase_path, kind, currency, observed_at, stale_at, catalog_fetch_id, payload_json)
         VALUES (?, 'porkbun', NULL, 'com', 'register', 'published', 'USD', ?, ?, ?, '{}')`,
        [randomUUID(), OLD, OLD, fetchId],
      );
      db.run("INSERT INTO best_prices (suffix, currency, provider_id, amount, years, kind, observed_at) VALUES ('com', 'USD', 'porkbun', '10.00', 1, 'published', ?)", [OLD]);
      db.run("INSERT INTO saved_criteria (id, name, payload_json, created_at, updated_at) VALUES (?, 'c', '{}', ?, ?)", [randomUUID(), OLD, OLD]);
      db.run("INSERT INTO extension_presets (id, name, extensions_json, created_at) VALUES ('p', 'p', '[]', ?)", [OLD]);
      db.run("INSERT INTO portfolio_entries (id, domain, created_at, updated_at) VALUES (?, 'mine.com', ?, ?)", [randomUUID(), OLD, OLD]);
      events.emit('job.progress', { jobId: ids.doneJob }, { jobId: ids.doneJob, counters });
      events.emit('job.progress', { jobId: ids.runningJob }, { jobId: ids.runningJob, counters });
    });
  });
  afterEach(() => t.close());

  const del = async (body: object) => DataDeleteResponse.parse((await t.api.post('/data/delete').send(body).expect(200)).body).data.deleted;

  it('reports the data directory, database size and per-category counts', async () => {
    const res = await t.api.get('/data').expect(200);
    const inventory = DataInventoryResponse.parse(res.body).data;
    expect(inventory.dataDir).toBe(t.config.dataDir);
    expect(inventory.databaseBytes).toBeGreaterThan(0);
    const counts = Object.fromEntries(inventory.categories.map((c) => [c.category, c.count]));
    expect(counts).toEqual({
      jobs: 2,
      registry_evidence: 2,
      provider_evidence: 1,
      price_history: 1,
      name_checks: 1,
      diagnostics: 0,
      raw_diagnostics: 1,
      collections: 2,
      criteria: 2,
      watches: 1,
      portfolio: 1,
      artifacts: 0,
    });
  });

  it('deletes evidence older than `before` for one kind, keeping newer and unrelated evidence', async () => {
    expect(await del({ categories: ['registry_evidence'], before: CUTOFF })).toEqual([{ category: 'registry_evidence', count: 1 }]);
    expect(count(db, 'observations', 'id = ?', [ids.newRegistry])).toBe(1);
    expect(count(db, 'observations', "kind IN ('name_check', 'confirmation')")).toBe(2);
    expect(count(db, 'raw_diagnostics')).toBe(0);
    expect(count(db, 'job_items', 'job_id = ? AND registry_observation_id IS NULL', [ids.doneJob])).toBe(1);
  });

  it('deletes finished jobs with their items and events but never active ones', async () => {
    const watermark = events.deletedThrough();
    expect(await del({ categories: ['jobs'] })).toEqual([{ category: 'jobs', count: 1 }]);
    expect(count(db, 'jobs', 'id = ?', [ids.runningJob])).toBe(1);
    expect(count(db, 'job_items')).toBe(1);
    expect(events.read(0).map((e) => e.jobId)).toEqual([ids.runningJob]);
    expect(events.deletedThrough()).toBeGreaterThan(watermark);
    expect(db.get<{ last_job_id: string | null }>('SELECT last_job_id FROM watches')?.last_job_id).toBeNull();
    expect(count(db, 'watch_runs', 'job_id IS NULL')).toBe(1);
    expect(count(db, 'observations')).toBe(4);
  });

  it('limits collection deletion to collectionIds and keeps the evidence', async () => {
    expect(await del({ categories: ['collections'], collectionIds: [ids.collectionA] })).toEqual([{ category: 'collections', count: 1 }]);
    expect(count(db, 'collections', 'id = ?', [ids.collectionB])).toBe(1);
    expect(count(db, 'collection_entries')).toBe(1);
    expect(count(db, 'observations')).toBe(4);
    const res = await t.api.post('/data/delete').send({ categories: ['jobs'], collectionIds: [ids.collectionA] }).expect(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('deletes prices, criteria, watches and portfolio while preserving other categories', async () => {
    const deleted = await del({ categories: ['price_history', 'criteria', 'watches', 'portfolio'] });
    expect(deleted).toEqual([
      { category: 'price_history', count: 1 },
      { category: 'criteria', count: 2 },
      { category: 'watches', count: 1 },
      { category: 'portfolio', count: 1 },
    ]);
    for (const table of ['offers', 'catalog_fetches', 'best_prices', 'watch_runs', 'notices', 'portfolio_entries']) {
      expect(count(db, table)).toBe(0);
    }
    expect(count(db, 'jobs')).toBe(2);
    expect(count(db, 'jobs', 'watch_id IS NULL')).toBe(2);
    expect(count(db, 'collections')).toBe(2);
    expect(count(db, 'observations')).toBe(4);
  });

  it('checkpoints the WAL after deleting', async () => {
    await del({ categories: ['registry_evidence'] });
    const wal = join(t.config.dataDir, 'domain-scout.sqlite-wal');
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
  });

  it('removes artifact records and files only inside <dataDir>/artifacts', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ds-outside-'));
    try {
      const artifacts = join(t.config.dataDir, 'artifacts');
      mkdirSync(artifacts, { recursive: true });
      const oldId = randomUUID();
      const newId = randomUUID();
      const sneaky = randomUUID();
      for (const name of ['old.csv', `${newId}.html`, `${newId}.json`, 'stray.txt']) writeFileSync(join(artifacts, name), 'x');
      writeFileSync(join(t.config.dataDir, 'keep.txt'), 'x');
      writeFileSync(join(outside, 'keep.txt'), 'x');
      const insert = (id: string, file: string, at: string) =>
        db.run(
          `INSERT INTO artifacts (id, kind, format, scope_json, item_count, file_name, size_bytes, created_at)
           VALUES (?, 'export', 'csv', '{}', 1, ?, 1, ?)`,
          [id, file, at],
        );
      // A symlinked entry pointing outside the data directory must never be followed.
      mkdirSync(join(outside, 'victim-dir'));
      writeFileSync(join(outside, 'victim-dir', 'victim.txt'), 'x');
      symlinkSync(join(outside, 'victim-dir'), join(artifacts, 'link'), 'dir');
      insert(oldId, 'old.csv', OLD);
      insert(sneaky, '../keep.txt', OLD);
      insert(randomUUID(), join(outside, 'keep.txt'), OLD);
      insert(randomUUID(), 'link/victim.txt', OLD);
      insert(newId, `${newId}.html`, NEW);

      expect(await del({ categories: ['artifacts'], before: CUTOFF })).toEqual([{ category: 'artifacts', count: 4 }]);
      expect(existsSync(join(artifacts, 'old.csv'))).toBe(false);
      expect(existsSync(join(artifacts, `${newId}.json`))).toBe(true);
      expect(existsSync(join(artifacts, 'stray.txt'))).toBe(true);
      expect(existsSync(join(outside, 'victim-dir', 'victim.txt'))).toBe(true);

      expect(await del({ categories: ['artifacts'] })).toEqual([{ category: 'artifacts', count: 1 }]);
      expect(existsSync(join(artifacts, `${newId}.html`))).toBe(false);
      expect(existsSync(join(artifacts, 'stray.txt'))).toBe(false);
      expect(existsSync(artifacts)).toBe(true);
      expect(existsSync(join(t.config.dataDir, 'keep.txt'))).toBe(true);
      expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
      expect(existsSync(join(outside, 'victim-dir', 'victim.txt'))).toBe(true);
      expect(existsSync(join(artifacts, 'link'))).toBe(false);
      expect(existsSync(join(t.config.dataDir, 'domain-scout.sqlite'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
