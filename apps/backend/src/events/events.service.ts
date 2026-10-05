import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import {
  CONTRACT_VERSION,
  EventPayloads,
  TRANSIENT_EVENT_TYPES,
  type DomainEvent,
  type EventType,
} from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { Database, json } from '../storage/database.js';

export interface EventRefs {
  jobId?: string | null;
  watchId?: string | null;
}

export interface EventFilter {
  jobId?: string;
  watchId?: string;
  types?: EventType[];
}

interface EventRow {
  id: number;
  type: EventType;
  job_id: string | null;
  watch_id: string | null;
  occurred_at: string;
  payload_json: string;
}

/** Transient progress events are replayable for this long, then compacted. */
export const TRANSIENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DELETED_THROUGH_KEY = 'events.deletedThrough';
const DELETE_BATCH = 5000;

/**
 * Durable event log. Call `emit` inside the same Database.transaction as the state change it
 * describes. Subscribers are only woken up; they re-read committed rows by cursor, so a rolled-back
 * event is never delivered.
 *
 * Every deletion (compaction, scoped data deletion) records the highest deleted id. A replay cursor
 * below that watermark may have missed events, so SSE answers it with `stream.reset`.
 */
@Injectable()
export class EventsService {
  private readonly wake = new EventEmitter();

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {
    this.wake.setMaxListeners(0);
  }

  /**
   * Appends an event. The payload is validated against the contract for `type` (heartbeats excepted)
   * and stored in its parsed form; an invalid payload throws, rolling back the caller's transaction
   * so a malformed event never enters durable replay.
   */
  emit(type: EventType, refs: EventRefs, payload: unknown): number {
    let stored = payload;
    if (type !== 'heartbeat') {
      const result = EventPayloads[type].safeParse(payload);
      if (!result.success) {
        // A plain Error (not ZodError) so an HTTP caller gets 500: this is a server bug, not bad input.
        const issue = result.error.issues[0];
        throw new Error(`Invalid ${type} event payload at ${issue?.path.join('.') || '(root)'}: ${issue?.message}`);
      }
      stored = result.data;
    }
    const transient = TRANSIENT_EVENT_TYPES.includes(type) ? 1 : 0;
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO events (type, job_id, watch_id, occurred_at, transient, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
      [type, refs.jobId ?? null, refs.watchId ?? null, this.clock.iso(), transient, json.stringify(stored)],
    );
    setImmediate(() => this.wake.emit('event', lastInsertRowid));
    return lastInsertRowid;
  }

  /** Register a wake-up listener; returns an unsubscribe function. */
  onWake(listener: (eventId: number) => void): () => void {
    this.wake.on('event', listener);
    return () => this.wake.off('event', listener);
  }

  /** Committed events after `afterId`, optionally filtered. */
  read(afterId: number, filter: EventFilter = {}, limit = 500): DomainEvent[] {
    const where = ['id > ?'];
    const params: (string | number)[] = [afterId];
    if (filter.jobId) {
      where.push('job_id = ?');
      params.push(filter.jobId);
    }
    if (filter.watchId) {
      where.push('watch_id = ?');
      params.push(filter.watchId);
    }
    if (filter.types?.length) {
      where.push(`type IN (${filter.types.map(() => '?').join(',')})`);
      params.push(...filter.types);
    }
    params.push(limit);
    return this.db
      .all<EventRow>(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`, params)
      .map((row) => ({
        contractVersion: CONTRACT_VERSION,
        eventId: String(row.id),
        type: row.type,
        occurredAt: row.occurred_at,
        jobId: row.job_id,
        watchId: row.watch_id,
        payload: json.parse(row.payload_json, {}),
      }));
  }

  /** Oldest retained event id, used to detect expired replay cursors. */
  oldestId(): number | null {
    return this.db.get<{ id: number | null }>('SELECT MIN(id) AS id FROM events')?.id ?? null;
  }

  /** Highest id ever assigned (AUTOINCREMENT high-water mark), even if that event was deleted since. */
  latestId(): number {
    const seq = this.db.get<{ seq: number | null }>("SELECT seq FROM sqlite_sequence WHERE name = 'events'")?.seq ?? 0;
    const max = this.db.get<{ id: number | null }>('SELECT MAX(id) AS id FROM events')?.id ?? 0;
    return Math.max(seq, max);
  }

  /** Highest event id removed so far; replay cursors below it are expired. */
  deletedThrough(): number {
    const row = this.db.get<{ value_json: string }>('SELECT value_json FROM metadata WHERE key = ?', [DELETED_THROUGH_KEY]);
    return json.parse<number>(row?.value_json, 0);
  }

  /** Deletes transient events older than the replay window, in bounded batches. Returns the count. */
  compact(now: Date = this.clock.now()): number {
    const cutoff = new Date(now.getTime() - TRANSIENT_RETENTION_MS).toISOString();
    let total = 0;
    for (;;) {
      const deleted = this.db.transaction(() => {
        const ids = this.db
          .all<{ id: number }>('SELECT id FROM events WHERE transient = 1 AND occurred_at < ? ORDER BY id LIMIT ?', [cutoff, DELETE_BATCH])
          .map((r) => r.id);
        if (ids.length === 0) return 0;
        const maxId = ids[ids.length - 1]!;
        this.db.run('DELETE FROM events WHERE transient = 1 AND occurred_at < ? AND id <= ?', [cutoff, maxId]);
        this.markDeleted(maxId);
        return ids.length;
      });
      total += deleted;
      if (deleted < DELETE_BATCH) return total;
    }
  }

  /**
   * Deletes every event referencing the given jobs or watches (their payloads carry domain names).
   * Call inside the transaction that deletes those records. Returns the count.
   */
  deleteFor(refs: { jobIds?: string[]; watchIds?: string[] }): number {
    let total = 0;
    for (const [column, ids] of [
      ['job_id', refs.jobIds ?? []],
      ['watch_id', refs.watchIds ?? []],
    ] as const) {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const marks = chunk.map(() => '?').join(',');
        const maxId = this.db.get<{ id: number | null }>(`SELECT MAX(id) AS id FROM events WHERE ${column} IN (${marks})`, chunk)?.id;
        if (maxId == null) continue;
        total += this.db.run(`DELETE FROM events WHERE ${column} IN (${marks})`, chunk).changes;
        this.markDeleted(maxId);
      }
    }
    return total;
  }

  /** Deletes every event (used when all jobs and watches are removed). Returns the count. */
  deleteAll(): number {
    const maxId = this.db.get<{ id: number | null }>('SELECT MAX(id) AS id FROM events')?.id;
    if (maxId == null) return 0;
    const { changes } = this.db.run('DELETE FROM events');
    this.markDeleted(maxId);
    return changes;
  }

  private markDeleted(maxId: number) {
    if (maxId <= this.deletedThrough()) return;
    this.db.run(
      `INSERT INTO metadata (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [DELETED_THROUGH_KEY, json.stringify(maxId), this.clock.iso()],
    );
  }
}
