import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import {
  CONTRACT_VERSION,
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

interface EventRow {
  id: number;
  type: EventType;
  job_id: string | null;
  watch_id: string | null;
  occurred_at: string;
  payload_json: string;
}

/**
 * Durable event log. Call `emit` inside the same Database.transaction as the state change it
 * describes. Subscribers are only woken up; they re-read committed rows by cursor, so a rolled-back
 * event is never delivered.
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

  emit(type: EventType, refs: EventRefs, payload: unknown): number {
    const transient = TRANSIENT_EVENT_TYPES.includes(type) ? 1 : 0;
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO events (type, job_id, watch_id, occurred_at, transient, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
      [type, refs.jobId ?? null, refs.watchId ?? null, this.clock.iso(), transient, json.stringify(payload)],
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
  read(afterId: number, filter: { jobId?: string; watchId?: string; types?: EventType[] } = {}, limit = 500): DomainEvent[] {
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

  latestId(): number {
    return this.db.get<{ id: number | null }>('SELECT MAX(id) AS id FROM events')?.id ?? 0;
  }
}
