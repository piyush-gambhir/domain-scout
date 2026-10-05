import { afterEach, describe, expect, it } from 'vitest';
import { ErrorResponse, JobListResponse, JobResponse } from '@domain-scout/contracts';
import { createJobsApp, fakeHandler, registryResult, type JobsTestApp } from './helpers.js';

describe('jobs API', () => {
  let t: JobsTestApp;
  afterEach(() => t?.close());

  it('replays the original job for a repeated Idempotency-Key and rejects a different body', async () => {
    t = await createJobsApp();
    const handler = fakeHandler({ operation: 'quote' });
    t.registry.use(handler, fakeHandler({ operation: 'registry' }));
    const body = { domains: ['a.com'], providerIds: ['porkbun'] };
    const first = JobResponse.parse((await t.api.post('/quotes').set('Idempotency-Key', 'key-1').send(body).expect(201)).body).data;
    await t.finished(first.id);
    // Same request with keys in another order and defaults spelled out: same fingerprint.
    const again = JobResponse.parse(
      (await t.api.post('/quotes').set('Idempotency-Key', 'key-1').send({ providerIds: ['porkbun'], domains: ['a.com'] }).expect(201)).body,
    ).data;
    expect(again.id).toBe(first.id);
    expect(handler.calls).toHaveLength(1);
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')!.n).toBe(1);

    const conflict = await t.api.post('/quotes').set('Idempotency-Key', 'key-1').send({ ...body, providerIds: ['namecheap'] }).expect(409);
    expect(ErrorResponse.parse(conflict.body).error.code).toBe('idempotency_conflict');
    // A key is scoped to its operation: reusing it on another route conflicts too.
    await t.api.post('/provider-checks').set('Idempotency-Key', 'key-1').send(body).expect(409);
    await t.api.post('/jobs').set('Idempotency-Key', 'bad key').send({ type: 'registry_scan', input: { text: 'a.com' } }).expect(400);

    // Without a key, each submission is a new job.
    const other = JobResponse.parse((await t.api.post('/quotes').send(body).expect(201)).body).data;
    expect(other.id).not.toBe(first.id);

    // Internal submissions (monitoring, catalogs) use the same idempotency through SubmitOptions.
    const viaPort = t.jobs.submit({ type: 'registry_scan', input: { domains: ['z.com'], format: 'auto', extensions: [] }, recheck: false }, { idempotencyKey: 'run-1', operationId: 'runWatch' });
    expect(t.jobs.submit({ type: 'registry_scan', input: { domains: ['z.com'], format: 'auto', extensions: [] }, recheck: false }, { idempotencyKey: 'run-1', operationId: 'runWatch' }).id).toBe(viaPort.id);
  });

  it('retries unresolved, selected or outcome-matched items as a new job', async () => {
    t = await createJobsApp();
    let healthy = false;
    const handler = fakeHandler({
      operation: 'registry',
      execute: (item, ctx) =>
        !healthy && item.subject.startsWith('bad')
          ? registryResult(item, ctx, 'blocked', { retryable: false, error: { code: 'blocked', message: 'blocked', retryable: false } })
          : registryResult(item, ctx, item.subject.startsWith('taken') ? 'registered' : 'no_record'),
    });
    t.registry.use(handler);
    const parent = JobResponse.parse(
      (await t.api.post('/jobs').send({ type: 'registry_scan', label: 'Batch', input: { text: 'ok.com bad1.com taken.com bad2.com', extensions: [] } }).expect(201)).body,
    ).data;
    const done = await t.finished(parent.id);
    expect(done.state).toBe('completed_with_errors');
    healthy = true;

    const retry = JobResponse.parse((await t.api.post(`/jobs/${parent.id}/retry`).set('Idempotency-Key', 'retry-1').send({}).expect(201)).body).data;
    expect(retry.parentJobId).toBe(parent.id);
    expect(retry.type).toBe('registry_scan');
    expect(retry.label).toBe('Batch');
    expect(retry.counters.total).toBe(2);
    const retried = await t.finished(retry.id);
    expect(retried.state).toBe('completed');
    expect(retried.counters.outcomes).toEqual({ no_record: 2 });
    // The parent keeps its original results.
    expect(t.jobs.get(parent.id).counters).toEqual(done.counters);
    const replay = JobResponse.parse((await t.api.post(`/jobs/${parent.id}/retry`).set('Idempotency-Key', 'retry-1').send({}).expect(201)).body).data;
    expect(replay.id).toBe(retry.id);

    const items = (await t.api.get(`/jobs/${parent.id}/results`).expect(200)).body.data as { id: string; subject: string }[];
    const selected = JobResponse.parse(
      (await t.api.post(`/jobs/${parent.id}/retry`).send({ itemIds: [items.find((i) => i.subject === 'taken.com')!.id] }).expect(201)).body,
    ).data;
    expect(selected.counters.total).toBe(1);
    const byOutcome = JobResponse.parse((await t.api.post(`/jobs/${parent.id}/retry`).send({ outcomes: ['registered', 'no_record'] }).expect(201)).body).data;
    expect(byOutcome.counters.total).toBe(2);
    const none = await t.api.post(`/jobs/${parent.id}/retry`).send({ outcomes: ['rate_limited'] }).expect(400);
    expect(ErrorResponse.parse(none.body).error.code).toBe('invalid_request');
  });

  it('rechecks domains with a fresh registry scan that skips cached evidence', async () => {
    t = await createJobsApp();
    const handler = fakeHandler({ operation: 'registry' });
    t.registry.use(handler);
    const job = JobResponse.parse((await t.api.post('/rechecks').send({ domains: ['a.com', 'b.io'], label: 'Before buying' }).expect(201)).body).data;
    expect(job.type).toBe('registry_scan');
    expect(job.input.text).toBe('a.com\nb.io');
    await t.finished(job.id);
    expect(handler.calls.map((c) => c.allowCache)).toEqual([false, false]);
    const scan = t.jobs.submit({ type: 'registry_scan', input: { domains: ['c.com'], format: 'auto', extensions: [] }, recheck: false });
    await t.finished(scan.id);
    expect(handler.calls.at(-1)!.allowCache).toBe(true);
  });

  it('lists, gets and deletes jobs; running jobs cannot be deleted and evidence stays', async () => {
    t = await createJobsApp();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    t.registry.use(
      fakeHandler({
        operation: 'registry',
        execute: async (item, ctx) => {
          if (item.subject === 'slow.com') await held;
          return registryResult(item, ctx);
        },
      }),
    );
    const done = t.jobs.submit({ type: 'registry_scan', input: { domains: ['a.com'], format: 'auto', extensions: [] }, recheck: false });
    await t.finished(done.id);
    const running = t.jobs.submit({ type: 'registry_scan', input: { domains: ['slow.com'], format: 'auto', extensions: [] }, recheck: false });

    const list = JobListResponse.parse((await t.api.get('/jobs?limit=1').expect(200)).body);
    expect(list.total).toBe(2);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]!.id).toBe(running.id);
    const next = JobListResponse.parse((await t.api.get(`/jobs?limit=1&cursor=${list.nextCursor}`).expect(200)).body);
    expect(next.data[0]!.id).toBe(done.id);
    expect(next.nextCursor).toBeNull();
    const finishedOnly = JobListResponse.parse((await t.api.get('/jobs?state=completed').expect(200)).body);
    expect(finishedOnly.data.map((j) => j.id)).toEqual([done.id]);
    await t.api.get(`/jobs/${done.id}`).expect(200);
    await t.api.get('/jobs/00000000-0000-4000-8000-000000000000').expect(404);

    expect(ErrorResponse.parse((await t.api.delete(`/jobs/${running.id}`).expect(409)).body).error.code).toBe('conflict');
    release();
    await t.finished(running.id);

    const observations = t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM observations')!.n;
    await t.api.delete(`/jobs/${done.id}`).expect(200);
    await t.api.get(`/jobs/${done.id}`).expect(404);
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM job_items WHERE job_id = ?', [done.id])!.n).toBe(0);
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM observations')!.n).toBe(observations);
    expect(t.jobEvents(done.id)).toHaveLength(0);
  });
});
