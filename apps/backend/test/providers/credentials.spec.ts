import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderResponse } from '@domain-scout/contracts';
import { QuoteHandler } from '../../src/providers/handlers.js';
import { Database } from '../../src/storage/database.js';
import { createProvidersApp, fixture, jobItem, operationContext, type ProvidersTestApp } from './helpers.js';

const SECRET = 'sk1_lifecycle_secret_0001';
const KEY = 'pk1_lifecycle_key_0001';

describe('provider credentials (R09)', () => {
  let t: ProvidersTestApp;
  const logged: string[] = [];
  beforeAll(async () => {
    t = await createProvidersApp({});
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args)));
    }
    for (const level of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args)));
    }
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    // Nothing logged during the lifecycle may contain a secret.
    expect(logged.join('\n')).not.toContain(SECRET);
    await t.close();
  });
  afterEach(() => t.transport.reset());

  const provider = async () => ProviderResponse.parse((await t.api.get('/providers/porkbun').expect(200)).body).data;

  it('starts missing, with setup guidance and env var names', async () => {
    const p = await provider();
    expect(p.readiness).toBe('credentials_missing');
    expect(p.credentials).toMatchObject({ configured: false, storage: null, fields: [{ key: 'apiKey', set: false }, { key: 'secretApiKey', set: false }] });
    expect(p.credentialFields.map((f) => f.envVar)).toEqual(['DOMAIN_SCOUT_PORKBUN_API_KEY', 'DOMAIN_SCOUT_PORKBUN_SECRET_API_KEY']);
    expect(p.setupUrl).toBe('https://porkbun.com/account/api');
    const test = await t.api.post('/providers/porkbun/credentials/test').expect(409);
    expect(test.body.error.code).toBe('credential_required');
  });

  it('rejects incomplete or unknown fields', async () => {
    await t.api.put('/providers/porkbun/credentials').send({ values: { apiKey: KEY }, storage: 'session' }).expect(400);
    await t.api.put('/providers/porkbun/credentials').send({ values: { apiKey: KEY, secretApiKey: SECRET, extra: 'x' }, storage: 'session' }).expect(400);
  });

  it('keeps session credentials in memory only and never returns them', async () => {
    const res = await t.api.put('/providers/porkbun/credentials').send({ values: { apiKey: KEY, secretApiKey: SECRET }, storage: 'session' }).expect(200);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    const p = ProviderResponse.parse(res.body).data;
    expect(p.credentials).toMatchObject({ configured: true, storage: 'session', storageLocation: null });
    expect(p.readiness).toBe('ready');
    expect(existsSync(join(t.config.dataDir, 'credentials.json'))).toBe(false);
    // Not in SQLite either.
    const db = t.app.get(Database);
    const dump = db.all('SELECT * FROM providers').map((r) => JSON.stringify(r)).join('\n') + db.all('SELECT * FROM settings').map((r) => JSON.stringify(r)).join('\n');
    expect(dump).not.toContain(SECRET);
  });

  it('tests with a non-candidate operation and stores the result', async () => {
    t.transport.on(/\/ping$/, fixture('porkbun', 'ping-ok'));
    const res = await t.api.post('/providers/porkbun/credentials/test').expect(200);
    expect(res.body.data).toMatchObject({ result: 'ok', operation: 'GET /ping' });
    expect(t.transport.requests[0]!.url).toBe('https://api.porkbun.com/api/json/v3/ping');
    expect(t.transport.requests[0]!.body).toBeUndefined();
    const p = await provider();
    expect(p.credentials).toMatchObject({ lastTestResult: 'ok', lastTestedAt: '2026-10-05T12:00:00.000Z' });
  });

  it('an invalid key marks the provider credentials_invalid with an actionable message', async () => {
    t.transport.on(/\/ping$/, fixture('porkbun', 'ping-invalid'));
    const res = await t.api.post('/providers/porkbun/credentials/test').expect(200);
    expect(res.body.data.result).toBe('failed');
    expect(res.body.data.message).toContain('porkbun.com/account/api');
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect((await provider()).readiness).toBe('credentials_invalid');
  });

  it('an expired key seen by an operation also marks credentials_invalid; new credentials reset it', async () => {
    t.transport.on(/checkDomain/, fixture('porkbun', 'ping-invalid'));
    const result = await t.app.get(QuoteHandler).execute(jobItem('quote', 'xq7mz9brandtest.com', 'porkbun', 'com'), operationContext(t));
    expect(result.outcome).toBe('credentials_invalid');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect((await provider()).readiness).toBe('credentials_invalid');
    await t.api.put('/providers/porkbun/credentials').send({ values: { apiKey: KEY, secretApiKey: SECRET }, storage: 'session' }).expect(200);
    const p = await provider();
    expect(p.readiness).toBe('ready');
    expect(p.credentials.lastTestResult).toBeNull();
  });

  it('saves to an owner-only file outside SQLite when asked, and reports its location', async () => {
    const res = await t.api.put('/providers/porkbun/credentials').send({ values: { apiKey: KEY, secretApiKey: SECRET }, storage: 'file' }).expect(200);
    const file = join(t.config.dataDir, 'credentials.json');
    expect(res.body.data.credentials).toMatchObject({ storage: 'file', storageLocation: file });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).providers.porkbun.values.secretApiKey).toBe(SECRET);
  });

  it('prefers environment variables over the file, and disconnect removes saved copies', async () => {
    t.env.DOMAIN_SCOUT_PORKBUN_API_KEY = 'pk1_env_key_0001';
    t.env.DOMAIN_SCOUT_PORKBUN_SECRET_API_KEY = 'sk1_env_secret_0001';
    expect((await provider()).credentials.storage).toBe('env');
    const res = await t.api.delete('/providers/porkbun/credentials').expect(200);
    // Environment variables cannot be removed from the app; they stay the active source.
    expect(res.body.data.credentials.storage).toBe('env');
    expect(JSON.parse(readFileSync(join(t.config.dataDir, 'credentials.json'), 'utf8')).providers.porkbun).toBeUndefined();
    delete t.env.DOMAIN_SCOUT_PORKBUN_API_KEY;
    delete t.env.DOMAIN_SCOUT_PORKBUN_SECRET_API_KEY;
    const p = await provider();
    expect(p.credentials.configured).toBe(false);
    expect(p.readiness).toBe('credentials_missing');
  });

  it('directory entries have nothing to configure or test', async () => {
    const res = await t.api.post('/providers/register-si-arnes-si/credentials/test').expect(200);
    expect(res.body.data.result).toBe('not_testable');
    const p = ProviderResponse.parse((await t.api.get('/providers/register-si-arnes-si').expect(200)).body).data;
    expect(p).toMatchObject({ kind: 'directory', readiness: 'keyless', suffixes: ['si'], credentialFields: [], apiHosts: [] });
    await t.api.put('/providers/register-si-arnes-si/credentials').send({ values: { x: 'y' }, storage: 'session' }).expect(400);
  });
});
