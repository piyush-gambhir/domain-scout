import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthResponse } from '@domain-scout/contracts';
import { createTestApp, type TestApp } from './helpers.js';

describe('health', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('returns the contract envelope', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(HealthResponse.parse(res.body).data.instanceId).toBe(t.config.instanceId);
  });
});
