import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorResponse, SessionInfoResponse } from '@domain-scout/contracts';
import { Database } from '../../src/storage/database.js';
import { createTestApp, type TestApp } from '../helpers.js';
import { SseClient } from '../events/sse-client.js';

const WEB = 'http://127.0.0.1:3000';

describe('local auth', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ autoAuth: false });
  });
  afterAll(() => t.close());

  it('serves health without credentials', async () => {
    await t.anon.get('/health').expect(200);
  });

  it('accepts the API token and rejects missing or wrong tokens with ErrorResponse 401', async () => {
    await t.api.get('/settings').expect(200);
    const missing = await t.anon.get('/settings').expect(401);
    expect(ErrorResponse.parse(missing.body).error.code).toBe('unauthorized');
    await t.anon.get('/settings').set('Authorization', 'Bearer wrong').expect(401);
    await t.anon.get('/settings').set('Authorization', `Basic ${t.token}`).expect(401);
  });

  it('echoes a valid X-Request-Id and generates one otherwise', async () => {
    const res = await t.anon.get('/settings').set('X-Request-Id', 'req-123').expect(401);
    expect(res.headers['x-request-id']).toBe('req-123');
    expect(res.body.error.requestId).toBe('req-123');
    const generated = await t.anon.get('/settings').set('X-Request-Id', 'bad id with spaces').expect(401);
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.body.error.requestId).toBe(generated.headers['x-request-id']);
  });

  it('rejects non-loopback Host headers (DNS rebinding) on every route', async () => {
    const res = await t.api.get('/settings').set('Host', 'evil.example').expect(403);
    expect(ErrorResponse.parse(res.body).error.code).toBe('forbidden');
    await t.anon.get('/health').set('Host', 'rebind.evil.example:4317').expect(403);
    await t.anon.get('/health').set('Host', 'localhost:1').expect(403);
    await t.anon.get('/health').set('Host', 'localhost').expect(403);
  });

  it('rejects a disallowed Origin on every route, public ones included', async () => {
    await t.api.get('/settings').set('Origin', 'http://evil.example').expect(403);
    await t.api.get('/settings').set('Origin', WEB).expect(200);
    await t.anon.get('/health').set('Origin', 'http://evil.example').expect(403);
    await t.anon.post('/auth/session').set('Origin', 'null').send({ code: 'x'.repeat(43) }).expect(403);
  });

  it('exchanges a single-use bootstrap code for a session', async () => {
    const created = await t.api.post('/auth/bootstrap-codes').expect(201);
    const { code, expiresAt } = created.body.data;
    expect(Date.parse(expiresAt) - t.clock.now().getTime()).toBe(60_000);
    const session = await t.anon.post('/auth/session').send({ code }).expect(201);
    const info = SessionInfoResponse.parse(session.body).data;
    expect(Date.parse(info.expiresAt) - t.clock.now().getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    const reused = await t.anon.post('/auth/session').send({ code }).expect(401);
    expect(reused.body.error.code).toBe('unauthorized');

    // Only hashes are stored.
    const db = t.app.get(Database);
    expect(JSON.stringify(db.all('SELECT * FROM bootstrap_codes'))).not.toContain(code);
    expect(JSON.stringify(db.all('SELECT * FROM sessions'))).not.toContain(info.sessionId);
  });

  it('expires bootstrap codes after 60 seconds', async () => {
    const { code } = (await t.api.post('/auth/bootstrap-codes').expect(201)).body.data;
    t.clock.advance(61_000);
    await t.anon.post('/auth/session').send({ code }).expect(401);
    await t.anon.post('/auth/session').send({ code: 'x'.repeat(43) }).expect(401);
  });

  it('authorizes sessions, requiring X-CSRF-Token on mutations and an allowed Origin', async () => {
    const s = await t.createSession();
    await t.anon.get('/settings').set('Cookie', s.cookie).expect(200);
    const info = await t.anon.get('/auth/session').set('Cookie', s.cookie).expect(200);
    expect(info.body.data).toEqual({ csrfToken: s.csrfToken, expiresAt: s.expiresAt });
    expect(info.body.data).not.toHaveProperty('sessionId');

    const patch = { appearance: { theme: 'dark' } };
    await t.anon.patch('/settings').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrfToken).set('Origin', WEB).send(patch).expect(200);
    const noCsrf = await t.anon.patch('/settings').set('Cookie', s.cookie).send(patch).expect(403);
    expect(noCsrf.body.error.code).toBe('forbidden');
    await t.anon.patch('/settings').set('Cookie', s.cookie).set('X-CSRF-Token', 'wrong').send(patch).expect(403);
    await t.anon
      .patch('/settings')
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', s.csrfToken)
      .set('Origin', 'http://evil.example')
      .send(patch)
      .expect(403);
    await t.anon.get('/settings').set('Cookie', 'ds_session=unknown').expect(401);
  });

  it('limits bootstrap codes to the token and session info to sessions', async () => {
    const s = await t.createSession();
    await t.anon.post('/auth/bootstrap-codes').set('Cookie', s.cookie).set('X-CSRF-Token', s.csrfToken).expect(403);
    await t.api.get('/auth/session').expect(403);
  });

  it('lets sessions open the event stream without CSRF', async () => {
    const s = await t.createSession();
    const base = await t.listen();
    const client = await SseClient.open(`${base}/api/v1/events`, { Cookie: s.cookie });
    expect(client.status).toBe(200);
    client.close();
    const denied = await SseClient.open(`${base}/api/v1/events`);
    expect(denied.status).toBe(401);
    denied.close();
  });

  it('expires sessions after 7 days', async () => {
    const s = await t.createSession();
    t.clock.advance(7 * 24 * 60 * 60 * 1000 + 1);
    await t.anon.get('/settings').set('Cookie', s.cookie).expect(401);
  });
});

describe('sessions across restarts', () => {
  it('stay valid when the backend restarts on the same data directory', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ds-restart-'));
    try {
      const config = { dataDir, runtimeDir: join(dataDir, 'run') };
      const first = await createTestApp({ autoAuth: false, config });
      const session = await first.createSession();
      await first.close();
      const second = await createTestApp({ autoAuth: false, config });
      await second.anon.get('/settings').set('Cookie', session.cookie).expect(200);
      await second.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
