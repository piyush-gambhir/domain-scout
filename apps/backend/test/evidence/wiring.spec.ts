import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers.js';

/** Boots the full AppModule: these modules must wire up next to every other module. */
describe('full application wiring', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t?.close());

  it('serves collections, criteria, presets, generation, watches, notices and artifacts', async () => {
    for (const path of ['/collections', '/criteria', '/presets', '/generation/themes', '/watches', '/notices', '/exports', '/snapshots']) {
      const res = await t.api.get(path);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
    }
  });
});
