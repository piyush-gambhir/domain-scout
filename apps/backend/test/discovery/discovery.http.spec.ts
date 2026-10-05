import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenerationPreviewResponse, GenerationThemeListResponse } from '@domain-scout/contracts';
import { DiscoveryModule } from '../../src/discovery/discovery.module.js';
import { createModuleApp, type ModuleApp } from '../evidence/harness.js';

describe('generation API', () => {
  let t: ModuleApp;
  beforeAll(async () => {
    t = await createModuleApp({ modules: [DiscoveryModule] });
  });
  afterAll(() => t.close());

  it('lists bundled themes', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/v1/generation/themes').expect(200);
    const body = GenerationThemeListResponse.parse(res.body);
    expect(body.data.map((theme) => theme.id).sort()).toEqual(['abstract', 'finance', 'nature', 'short', 'tech']);
    expect(body.total).toBe(5);
  });

  it('previews candidates with counts and expanded checks', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/v1/generation/preview')
      .send({ roots: ['cloud'], prefixes: ['get'], strategies: ['roots', 'affixes'], extensions: ['com', 'io'] })
      .expect(200);
    const body = GenerationPreviewResponse.parse(res.body);
    expect(body.data.candidates.map((c) => c.name)).toEqual(['cloud', 'getcloud']);
    expect(body.data.counts).toEqual({ generated: 2, unique: 2, duplicates: 0, invalid: 0, filtered: 0 });
    expect(body.data.expandedChecks).toBe(4);
  });

  it('rejects an unknown strategy and contradictory rules', async () => {
    const server = t.app.getHttpServer();
    const bad = await request(server).post('/api/v1/generation/preview').send({ strategies: ['scrape'] }).expect(400);
    expect(bad.body.error.code).toBe('invalid_request');
    await request(server)
      .post('/api/v1/generation/preview')
      .send({ roots: ['cloud'], rules: { minLength: 9, maxLength: 4 } })
      .expect(400);
  });
});
