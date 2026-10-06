import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HistoryListResponse, JobListResponse, JobResponse } from '@domain-scout/contracts';
import { createJobsApp, fakeHandler, type JobsTestApp } from './helpers.js';

describe('job origin', () => {
  let t: JobsTestApp;
  beforeAll(async () => {
    t = await createJobsApp();
    t.registry.use(fakeHandler({ operation: 'registry' }));
  });
  afterAll(() => t.close());

  const scan = (client?: string) => {
    const req = request(t.app.getHttpServer())
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${t.token}`)
      .send({ type: 'registry_scan', input: { text: 'a.com' } });
    return client ? req.set('X-Domain-Scout-Client', client) : req;
  };

  it('records who submitted a job and filters lists and history by it', async () => {
    const web = JobResponse.parse((await scan('web').expect(201)).body).data;
    const cli = JobResponse.parse((await scan('cli').expect(201)).body).data;
    const api = JobResponse.parse((await scan().expect(201)).body).data;
    expect([web.origin, cli.origin, api.origin]).toEqual(['ui', 'cli', 'api']);

    const listed = JobListResponse.parse((await t.api.get('/jobs?origins=ui,cli').expect(200)).body).data;
    expect(listed.map((j) => j.id).sort()).toEqual([web.id, cli.id].sort());
    const history = HistoryListResponse.parse((await t.api.get('/history?origins=cli').expect(200)).body).data;
    expect(history.map((h) => [h.jobId, h.origin])).toEqual([[cli.id, 'cli']]);
  });
});
