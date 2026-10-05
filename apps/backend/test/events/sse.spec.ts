import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainEvent, type EventType } from '@domain-scout/contracts';
import { EventsController, SSE_OPTIONS } from '../../src/events/events.controller.js';
import { EventsService, type EventRefs } from '../../src/events/events.service.js';
import { Clock } from '../../src/core/clock.js';
import type { ShutdownCoordinator } from '../../src/runtime/shutdown.js';
import { Database } from '../../src/storage/database.js';
import { createTestApp, type TestApp } from '../helpers.js';
import { SseClient } from './sse-client.js';

const JOB_A = randomUUID();
const JOB_B = randomUUID();
const counters = { total: 1, pending: 1, running: 0, finished: 0, interrupted: 0, resolved: 0, unresolved: 0, outcomes: {} };
const cooldown = (n: number) => ({ sourceId: `registry:test-${n}`, until: '2026-10-05T12:05:00.000Z', reason: 'rate_limited' });

describe('SSE events', () => {
  let t: TestApp;
  let base: string;
  let events: EventsService;
  let db: Database;
  const clients: SseClient[] = [];

  const emit = (type: EventType, refs: EventRefs, payload: unknown) => db.transaction(() => events.emit(type, refs, payload));
  const open = async (query = '', headers: Record<string, string> = {}) => {
    const client = await SseClient.open(`${base}/api/v1/events${query}`, { Authorization: `Bearer ${t.token}`, ...headers });
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    t = await createTestApp({ overrides: [{ provide: SSE_OPTIONS, useValue: { heartbeatMs: 100, batchSize: 2 } }] });
    base = await t.listen();
    events = t.app.get(EventsService);
    db = t.app.get(Database);
  });
  afterAll(async () => {
    for (const client of clients) client.close();
    await t.close();
  });

  it('streams committed events from the current end with id, event and data', async () => {
    emit('source.cooldown', {}, cooldown(0));
    const client = await open();
    expect(client.status).toBe(200);
    expect(client.res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(client.res.headers['cache-control']).toContain('no-cache');
    const id = emit('source.cooldown', {}, cooldown(1));
    await client.waitFor(() => client.events().length >= 1);
    const [message] = client.events();
    expect(message).toMatchObject({ id: String(id), event: 'source.cooldown' });
    expect(DomainEvent.parse(message!.json)).toMatchObject({ eventId: String(id), type: 'source.cooldown', payload: cooldown(1) });
    client.close();
  });

  it('replays after Last-Event-ID (which wins over ?after=) across batches', async () => {
    const ids = [emit('source.cooldown', {}, cooldown(2)), emit('source.cooldown', {}, cooldown(3)), emit('source.cooldown', {}, cooldown(4))];
    const byHeader = await open(`?after=${ids[1]}`, { 'Last-Event-ID': String(ids[0]! - 1) });
    await byHeader.waitFor(() => byHeader.events().length >= 3);
    expect(byHeader.events().map((m) => Number(m.id))).toEqual(ids);
    const byQuery = await open(`?after=${ids[0]}`);
    await byQuery.waitFor(() => byQuery.events().length >= 2);
    expect(byQuery.events().map((m) => Number(m.id))).toEqual(ids.slice(1));
    byHeader.close();
    byQuery.close();
  });

  it('filters by job and by type', async () => {
    const start = events.latestId();
    const a = emit('job.progress', { jobId: JOB_A }, { jobId: JOB_A, counters });
    emit('job.progress', { jobId: JOB_B }, { jobId: JOB_B, counters });
    const catalog = emit('catalog.updated', {}, { providerId: 'porkbun', suffixCount: 3, fetchedAt: '2026-10-05T12:00:00.000Z' });
    const byJob = await open(`?after=${start}&jobId=${JOB_A}`);
    const byType = await open(`?after=${start}&types=catalog.updated,notice.created`);
    await byJob.waitFor(() => byJob.events().length >= 1);
    await byType.waitFor(() => byType.events().length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(byJob.events().map((m) => Number(m.id))).toEqual([a]);
    expect(byType.events().map((m) => Number(m.id))).toEqual([catalog]);
    byJob.close();
    byType.close();
  });

  it('heartbeats carry the latest scanned cursor even when nothing matched', async () => {
    const client = await open(`?jobId=${randomUUID()}`);
    const other = emit('source.cooldown', {}, cooldown(5));
    await client.waitFor((m) => m.some((x) => x.event === 'heartbeat' && x.id === String(other)), 2000);
    const beat = client.messages.find((x) => x.event === 'heartbeat')!;
    expect(DomainEvent.parse(beat.json)).toMatchObject({ type: 'heartbeat', payload: {} });
    expect(client.events()).toEqual([]);
    client.close();
  });

  it('sends stream.reset for a cursor older than retained events, then continues live', async () => {
    const before = events.latestId();
    const transient = emit('job.progress', { jobId: JOB_A }, { jobId: JOB_A, counters });
    const durable = emit('source.cooldown', {}, cooldown(6));
    t.clock.advance(25 * 60 * 60 * 1000);
    expect(events.compact()).toBeGreaterThanOrEqual(1);
    expect(events.deletedThrough()).toBeGreaterThanOrEqual(transient);

    const expired = await open(`?after=${before}`);
    await expired.waitFor((m) => m.length >= 1);
    expect(expired.messages[0]).toMatchObject({ event: 'stream.reset', id: String(events.latestId()) });
    expect(expired.messages[0]!.json.payload).toMatchObject({ reason: 'cursor_expired' });
    const live = emit('source.cooldown', {}, cooldown(7));
    await expired.waitFor(() => expired.events().some((m) => m.id === String(live)));
    expect(expired.events().map((m) => m.event)).toEqual(['stream.reset', 'source.cooldown']);

    // A cursor at or past the deletion watermark replays normally.
    const fresh = await open(`?after=${transient}`);
    await fresh.waitFor(() => fresh.events().length >= 2);
    expect(fresh.events().map((m) => Number(m.id))).toEqual([durable, live]);

    const unknown = await open(`?after=${events.latestId() + 100}`);
    await unknown.waitFor((m) => m.length >= 1);
    expect(unknown.messages[0]!.json.payload).toMatchObject({ reason: 'cursor_unknown' });
    for (const c of [expired, fresh, unknown]) c.close();
  });

  it('releases the stream when the client disconnects', async () => {
    const controller = t.app.get(EventsController) as unknown as { open: Map<unknown, unknown> };
    for (const client of clients) client.close();
    const deadline = Date.now() + 2000;
    while (controller.open.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(controller.open.size).toBe(0);
  });

  it('rejects unknown types and malformed cursors before streaming', async () => {
    expect((await t.api.get('/events?types=job.updated,bogus').expect(400)).body.error.code).toBe('invalid_request');
    await t.api.get('/events').set('Last-Event-ID', 'abc').expect(400);
  });
});

describe('event log', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('rejects malformed payloads, rolling back the state change with them', () => {
    const db = t.app.get(Database);
    const events = t.app.get(EventsService);
    const latest = events.latestId();
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO metadata (key, value_json, updated_at) VALUES ('probe', '1', 'x')");
        events.emit('source.cooldown', {}, { sourceId: 'x' });
      }),
    ).toThrow(/Invalid source.cooldown event payload/);
    expect(db.get("SELECT 1 FROM metadata WHERE key = 'probe'")).toBeUndefined();
    expect(events.latestId()).toBe(latest);
  });

  it('compacts only transient events older than 24 hours', () => {
    const db = t.app.get(Database);
    const events = t.app.get(EventsService);
    const emit = (type: EventType, payload: unknown) => db.transaction(() => events.emit(type, {}, payload));
    const old = emit('job.progress', { jobId: JOB_A, counters });
    const kept = emit('source.cooldown', cooldown(1));
    t.clock.advance(23 * 60 * 60 * 1000);
    const recent = emit('job.progress', { jobId: JOB_A, counters });
    t.clock.advance(2 * 60 * 60 * 1000);
    expect(events.compact()).toBe(1);
    expect(events.read(0).map((e) => Number(e.eventId))).toEqual([kept, recent]);
    expect(events.deletedThrough()).toBe(old);
  });
});

describe('SSE backpressure', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  /** Response whose socket buffer is full until `drain`. */
  class StalledResponse extends EventEmitter {
    writes: string[] = [];
    accepting = false;
    status() {
      return this;
    }
    setHeader() {}
    flushHeaders() {}
    write(chunk: string) {
      this.writes.push(chunk);
      return this.accepting;
    }
    end() {}
  }

  it('stops writing heartbeats and events to a stalled reader until it drains', async () => {
    const shutdown = { onStopping: () => () => undefined } as unknown as ShutdownCoordinator;
    const controller = new EventsController(t.app.get(EventsService), t.app.get(Clock), shutdown, { heartbeatMs: 10 });
    const res = new StalledResponse();
    const req = { headers: {}, socket: { setNoDelay() {}, setTimeout() {} } };
    controller.stream({ params: undefined, query: {}, body: undefined }, req as never, res as never);

    await new Promise((r) => setTimeout(r, 80));
    expect(res.writes).toHaveLength(1);
    const db = t.app.get(Database);
    db.transaction(() => t.app.get(EventsService).emit('source.cooldown', {}, cooldown(9)));
    await new Promise((r) => setTimeout(r, 30));
    expect(res.writes).toHaveLength(1);

    res.accepting = true;
    res.emit('drain');
    expect(res.writes.some((w) => w.includes('event: source.cooldown'))).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(res.writes.filter((w) => w.includes('event: heartbeat')).length).toBeGreaterThan(1);
    res.emit('close');
  });
});
