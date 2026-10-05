import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SettingsResponse } from '@domain-scout/contracts';
import { SettingsService } from '../../src/system/settings.service.js';
import { Database } from '../../src/storage/database.js';
import { createTestApp, type TestApp } from '../helpers.js';

describe('settings', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('returns defaults', async () => {
    const res = await t.api.get('/settings').expect(200);
    expect(SettingsResponse.parse(res.body).data).toEqual(DEFAULT_SETTINGS);
  });

  it('merges a partial patch, persists it and notifies listeners after commit', async () => {
    const seen: number[] = [];
    const off = t.app.get(SettingsService).onChange((s) => seen.push(s.concurrency.global));
    const res = await t.api.patch('/settings').send({ concurrency: { global: 8 }, appearance: { theme: 'dark' } }).expect(200);
    off();
    expect(res.body.data.concurrency).toEqual({ ...DEFAULT_SETTINGS.concurrency, global: 8 });
    expect(res.body.data.appearance.theme).toBe('dark');
    expect(seen).toEqual([8]);
    const again = await t.api.get('/settings').expect(200);
    expect(again.body.data.concurrency.global).toBe(8);
    expect(again.body.data.retries).toEqual(DEFAULT_SETTINGS.retries);
  });

  it('rejects out-of-range and mistyped values with 400 and paths', async () => {
    const res = await t.api.patch('/settings').send({ concurrency: { global: 0 }, retries: { maxAttempts: 'x' } }).expect(400);
    expect(res.body.error.code).toBe('invalid_request');
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['body.concurrency.global', 'body.retries.maxAttempts']));
    expect((await t.api.get('/settings')).body.data.concurrency.global).toBe(8);
  });

  it('refuses to patch inside an outer transaction so the cache never holds uncommitted settings', () => {
    const settings = t.app.get(SettingsService);
    const db = t.app.get(Database);
    expect(() => db.transaction(() => settings.patch({ concurrency: { global: 2 } }))).toThrow(/inside another transaction/);
    expect(settings.get().concurrency.global).toBe(8);
  });
});
