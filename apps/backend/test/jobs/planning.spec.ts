import { afterEach, describe, expect, it } from 'vitest';
import { ErrorResponse, JobResponse, type Job } from '@domain-scout/contracts';
import { createJobsApp, fakeHandler, gate, type JobsTestApp } from './helpers.js';

/** Item rows of a job in input order. */
function items(t: JobsTestApp, jobId: string) {
  return t.db.all<{ subject: string; unicode: string; suffix: string | null; operation: string; target: string; source_key: string; seq: number }>(
    'SELECT subject, unicode, suffix, operation, target, source_key, seq FROM job_items WHERE job_id = ? ORDER BY seq',
    [jobId],
  );
}

describe('job planning', () => {
  let t: JobsTestApp;
  afterEach(() => t?.close());

  it('plans a registry scan from the previewer: unique valid domains in input order, restorable text', async () => {
    t = await createJobsApp();
    const hold = gate();
    t.registry.use(
      fakeHandler({
        operation: 'registry',
        sourceKey: (item) => `registry:${item.suffix}`,
        destination: (item) => `https://rdap.${item.suffix}.test/`,
        execute: async (item, ctx) => {
          await hold.promise;
          return { outcome: 'no_record', resolved: true, evidence: [] };
        },
      }),
    );
    const text = 'Beta.com\nalpha\nbad_name!.com\nbeta.com';
    const res = await t.api
      .post('/jobs')
      .send({ type: 'registry_scan', label: 'First scan', input: { text, extensions: ['io', 'dev'] } })
      .expect(201);
    const job = JobResponse.parse(res.body).data;
    expect(job.type).toBe('registry_scan');
    expect(job.state).toBe('queued');
    expect(job.label).toBe('First scan');
    expect(job.input).toEqual({ extensions: ['io', 'dev'], providerIds: [], services: [], checks: [], rows: 4, text });
    expect(job.counters).toMatchObject({ total: 3, pending: 3, finished: 0 });
    expect(job.destinations.sort()).toEqual(['https://rdap.com.test/', 'https://rdap.dev.test/', 'https://rdap.io.test/']);
    expect(items(t, job.id)).toEqual([
      { subject: 'beta.com', unicode: 'beta.com', suffix: 'com', operation: 'registry', target: '', source_key: 'registry:com', seq: 0 },
      { subject: 'alpha.io', unicode: 'alpha.io', suffix: 'io', operation: 'registry', target: '', source_key: 'registry:io', seq: 1 },
      { subject: 'alpha.dev', unicode: 'alpha.dev', suffix: 'dev', operation: 'registry', target: '', source_key: 'registry:dev', seq: 2 },
    ]);
    const first = t.jobEvents(job.id)[0]!;
    expect(first.type).toBe('job.updated');
    expect((first.payload as Job).state).toBe('queued');
    hold.open();
    expect((await t.finished(job.id)).state).toBe('completed');
  });

  it('rejects a registry scan when no input normalizer is available (503) and when nothing is valid (400)', async () => {
    t = await createJobsApp({ previewer: null });
    t.registry.use(fakeHandler({ operation: 'registry' }));
    const res = await t.api.post('/jobs').send({ type: 'registry_scan', input: { text: 'example.com' } }).expect(503);
    expect(ErrorResponse.parse(res.body).error.code).toBe('unavailable');
    await t.close();

    t = await createJobsApp();
    t.registry.use(fakeHandler({ operation: 'registry' }));
    const bad = await t.api.post('/jobs').send({ type: 'registry_scan', input: { text: 'bad_name!.com' } }).expect(400);
    expect(ErrorResponse.parse(bad.body).error.code).toBe('invalid_request');
  });

  it('fails with 503 naming the operation when no handler is registered', async () => {
    t = await createJobsApp();
    const res = await t.api.post('/quotes').send({ domains: ['example.com'], providerIds: ['porkbun'] }).expect(503);
    const error = ErrorResponse.parse(res.body).error;
    expect(error.code).toBe('unavailable');
    expect(error.message).toContain('quote');
  });

  it('expands provider operations domains x providers and validates provider ids', async () => {
    t = await createJobsApp();
    for (const operation of ['provider_check', 'quote', 'transfer'] as const) {
      t.registry.use(
        fakeHandler({ operation, sourceKey: (i) => `provider:${i.target}`, destination: (i) => `https://api.${i.target}.test/` }),
      );
    }
    const paths = { provider_check: '/provider-checks', quote: '/quotes', transfer: '/transfers' } as const;
    for (const [type, path] of Object.entries(paths)) {
      const res = await t.api
        .post(path)
        .send({ domains: ['a.com', 'b.co.uk', 'a.com'], providerIds: ['porkbun', 'namecheap'] })
        .expect(201);
      const job = JobResponse.parse(res.body).data;
      expect(job.type).toBe(type);
      expect(job.input.providerIds).toEqual(['porkbun', 'namecheap']);
      expect(job.destinations.sort()).toEqual(['https://api.namecheap.test/', 'https://api.porkbun.test/']);
      expect(items(t, job.id).map((i) => [i.subject, i.suffix, i.operation, i.target, i.source_key])).toEqual([
        ['a.com', 'com', type, 'porkbun', 'provider:porkbun'],
        ['a.com', 'com', type, 'namecheap', 'provider:namecheap'],
        ['b.co.uk', 'co.uk', type, 'porkbun', 'provider:porkbun'],
        ['b.co.uk', 'co.uk', type, 'namecheap', 'provider:namecheap'],
      ]);
    }
    const unknown = await t.api.post('/quotes').send({ domains: ['a.com'], providerIds: ['nosuch'] }).expect(400);
    const error = ErrorResponse.parse(unknown.body).error;
    expect(error.code).toBe('invalid_request');
    expect(error.source).toBe('nosuch');
    const invalid = await t.api.post('/quotes').send({ domains: ['a.invalid'], providerIds: ['porkbun'] }).expect(400);
    expect(ErrorResponse.parse(invalid.body).error.details?.[0]?.message).toContain('a.invalid');
  });

  it('plans aftermarket, name checks and diagnostics', async () => {
    t = await createJobsApp();
    t.registry.use(
      fakeHandler({ operation: 'aftermarket', sourceKey: (i) => `provider:${i.target}` }),
      fakeHandler({ operation: 'name_check', sourceKey: (i) => `service:${i.target}`, destination: (i) => `${i.target}.test` }),
      fakeHandler({ operation: 'diagnostic', sourceKey: (i) => `host:${i.subject}` }),
    );
    const market = JobResponse.parse(
      (await t.api.post('/aftermarket').send({ domains: ['a.com'], sources: ['sedo', 'afternic'] }).expect(201)).body,
    ).data;
    expect(market.type).toBe('aftermarket');
    expect(items(t, market.id).map((i) => [i.subject, i.operation, i.target])).toEqual([
      ['a.com', 'aftermarket', 'sedo'],
      ['a.com', 'aftermarket', 'afternic'],
    ]);

    const names = JobResponse.parse(
      (await t.api.post('/name-checks').send({ names: ['acme', ' acme ', 'Zeta'], services: ['github', 'npm'] }).expect(201)).body,
    ).data;
    expect(names.input.services).toEqual(['github', 'npm']);
    expect(names.destinations.sort()).toEqual(['github.test', 'npm.test']);
    expect(items(t, names.id).map((i) => [i.subject, i.suffix, i.operation, i.target])).toEqual([
      ['acme', null, 'name_check', 'github'],
      ['acme', null, 'name_check', 'npm'],
      ['Zeta', null, 'name_check', 'github'],
      ['Zeta', null, 'name_check', 'npm'],
    ]);

    const diag = JobResponse.parse(
      (await t.api.post('/diagnostics').send({ domains: ['a.com', 'b.io'], checks: ['dns', 'tls'], resolver: 'cloudflare' }).expect(201))
        .body,
    ).data;
    expect(diag.input.checks).toEqual(['dns', 'tls']);
    expect(items(t, diag.id).map((i) => [i.subject, i.operation, i.target])).toEqual([
      ['a.com', 'diagnostic', 'dns'],
      ['a.com', 'diagnostic', 'tls'],
      ['b.io', 'diagnostic', 'dns'],
      ['b.io', 'diagnostic', 'tls'],
    ]);
    const stored = t.db.get<{ input_json: string }>('SELECT input_json FROM jobs WHERE id = ?', [diag.id])!;
    expect(JSON.parse(stored.input_json).resolver).toBe('cloudflare');
  });

  it('defaults an omitted diagnostics resolver to the configured setting at planning time', async () => {
    t = await createJobsApp();
    t.registry.use(
      fakeHandler({
        operation: 'diagnostic',
        sourceKey: (i) => `resolver:${String(i.jobInput.resolver)}`,
        destination: (i) => `${String(i.jobInput.resolver)}.test`,
      }),
    );
    t.settings.patch({ diagnostics: { resolver: 'google' } });
    const configured = JobResponse.parse((await t.api.post('/diagnostics').send({ domains: ['a.com'], checks: ['dns'] }).expect(201)).body).data;
    expect(configured.destinations).toEqual(['google.test']);
    expect(items(t, configured.id).map((i) => i.source_key)).toEqual(['resolver:google']);
    const stored = (id: string) => JSON.parse(t.db.get<{ input_json: string }>('SELECT input_json FROM jobs WHERE id = ?', [id])!.input_json);
    expect(stored(configured.id).resolver).toBe('google');

    // A later settings change does not alter the submitted job; an explicit resolver wins.
    t.settings.patch({ diagnostics: { resolver: 'cloudflare' } });
    expect(stored(configured.id).resolver).toBe('google');
    const explicit = JobResponse.parse(
      (await t.api.post('/diagnostics').send({ domains: ['a.com'], checks: ['dns'], resolver: 'system' }).expect(201)).body,
    ).data;
    expect(stored(explicit.id).resolver).toBe('system');
  });

  it('plans internal catalog refresh and watch jobs', async () => {
    t = await createJobsApp();
    t.registry.use(
      fakeHandler({ operation: 'registry', sourceKey: () => 'registry:test' }),
      fakeHandler({ operation: 'quote', sourceKey: (i) => `provider:${i.target}` }),
      fakeHandler({ operation: 'catalog', sourceKey: (i) => `provider:${i.subject}`, destination: (i) => `https://${i.subject}.test/pricing` }),
    );
    const catalog = t.jobs.submit({ type: 'catalog_refresh', providerIds: ['porkbun', 'hostinger'] });
    expect(catalog.type).toBe('catalog_refresh');
    expect(catalog.destinations).toEqual(['https://porkbun.test/pricing', 'https://hostinger.test/pricing']);
    expect(items(t, catalog.id).map((i) => [i.subject, i.suffix, i.operation, i.target])).toEqual([
      ['porkbun', null, 'catalog', 'porkbun'],
      ['hostinger', null, 'catalog', 'hostinger'],
    ]);
    expect(() => t.jobs.submit({ type: 'catalog_refresh', providerIds: ['nosuch'] })).toThrow(/Unknown provider/);

    const now = new Date().toISOString();
    const watchId = '00000000-0000-4000-8000-000000000001';
    t.db.run(
      `INSERT INTO watches (id, name, domains_json, interval_minutes, state, created_at, updated_at) VALUES (?, 'w', '[]', 60, 'active', ?, ?)`,
      [watchId, now, now],
    );
    const watch = t.jobs.submit({
      type: 'watch',
      watchId,
      domains: ['a.com', 'b.io'],
      includeRegistry: true,
      providerIds: ['porkbun'],
      includeCatalogPrices: true,
    });
    expect(watch.type).toBe('watch');
    expect(watch.watchId).toBe(watchId);
    expect(items(t, watch.id).map((i) => [i.subject, i.operation, i.target])).toEqual([
      ['a.com', 'registry', ''],
      ['a.com', 'quote', 'porkbun'],
      ['b.io', 'registry', ''],
      ['b.io', 'quote', 'porkbun'],
      ['porkbun', 'catalog', 'porkbun'],
    ]);
    const done = await t.finished(watch.id);
    expect(done.state).toBe('completed');
    expect(t.jobEvents(watch.id).every((e) => e.watchId === watchId)).toBe(true);

    const noRegistry = t.jobs.submit({
      type: 'watch',
      watchId,
      domains: ['a.com'],
      includeRegistry: false,
      providerIds: ['porkbun'],
      includeCatalogPrices: false,
    });
    expect(items(t, noRegistry.id).map((i) => i.operation)).toEqual(['quote']);
    expect(() =>
      t.jobs.submit({ type: 'watch', watchId: '00000000-0000-4000-8000-000000000002', domains: ['a.com'], includeRegistry: true, providerIds: [], includeCatalogPrices: false }),
    ).toThrow(/Watch not found/);
  });
});
