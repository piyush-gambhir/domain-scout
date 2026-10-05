import { Injectable } from '@nestjs/common';
import type { Job, JobCounters, JobListQuery, JobOperation, JobState, JobType } from '@domain-scout/contracts';
import type { z } from 'zod';
import { AppError } from '../core/errors.js';
import { decodeCursor, encodeCursor } from '../core/envelope.js';
import { Database, json } from '../storage/database.js';

export interface JobRow {
  id: string;
  type: JobType;
  state: JobState;
  label: string | null;
  input_json: string;
  destinations_json: string;
  policy_json: string;
  watch_id: string | null;
  parent_job_id: string | null;
  total: number;
  pending: number;
  running: number;
  finished: number;
  interrupted: number;
  resolved: number;
  unresolved: number;
  outcomes_json: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  next_retry_at: string | null;
}

export interface ItemRow {
  id: string;
  job_id: string;
  seq: number;
  subject: string;
  unicode: string;
  suffix: string | null;
  operation: JobOperation;
  target: string;
  source_key: string;
  state: 'pending' | 'running' | 'finished' | 'interrupted';
  attempts: number;
  outcome: string | null;
  resolved: number;
  error_json: string | null;
  retry_at: string | null;
  not_before: string | null;
  registry_observation_id: string | null;
  evidence_json: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

/** Shape of job_items.evidence_json: ids of evidence other than the registry observation. */
export interface ItemEvidenceRefs {
  observations?: string[];
  offers?: string[];
  /** True when registry_observation_id points at cached evidence reused instead of a new query. */
  reusedRegistry?: boolean;
}

/** Public summary of what a job was asked to do (Job.input minus the restorable text). */
export interface JobInputSummary {
  extensions: string[];
  providerIds: string[];
  services: string[];
  checks: string[];
  rows: number;
}

/**
 * Stored jobs.input_json: the validated request fields, planner flags and the public summary.
 * Handlers receive this object as JobItemRecord.jobInput.
 */
export type StoredJobInput = Record<string, unknown> & { type: JobType; recheck: boolean; summary: JobInputSummary };

/** Mutable job state the scheduler tracks in memory and persists after each change. */
export interface RunSnapshot {
  state: JobState;
  counters: JobCounters;
  startedAt: string | null;
  finishedAt: string | null;
  nextRetryAt: string | null;
}

export function emptyCounters(): JobCounters {
  return { total: 0, pending: 0, running: 0, finished: 0, interrupted: 0, resolved: 0, unresolved: 0, outcomes: {} };
}

export function cloneCounters(c: JobCounters): JobCounters {
  return { ...c, outcomes: { ...c.outcomes } };
}

export function countersOf(row: JobRow): JobCounters {
  return {
    total: row.total,
    pending: row.pending,
    running: row.running,
    finished: row.finished,
    interrupted: row.interrupted,
    resolved: row.resolved,
    unresolved: row.unresolved,
    outcomes: json.parse<Record<string, number>>(row.outcomes_json, {}),
  };
}

/** How a registry scan read its input, so a restore reads it the same way. */
function inputReading(input: StoredJobInput): { format: 'auto' | 'lines' | 'csv' | null; csvColumn: string | null } {
  if (input.type !== 'registry_scan') return { format: null, csvColumn: null };
  const source = (input.input ?? {}) as { text?: string; format?: string; csvColumn?: string };
  if (typeof source.text !== 'string') return { format: 'lines', csvColumn: null };
  const format = source.format === 'csv' || source.format === 'lines' ? source.format : 'auto';
  return { format, csvColumn: typeof source.csvColumn === 'string' ? source.csvColumn : null };
}

/** Original text that restores a registry scan: pasted text, else the submitted domain list. */
function restorableText(input: StoredJobInput): string | null {
  if (input.type !== 'registry_scan') return null;
  const source = (input.input ?? {}) as { text?: string; domains?: string[] };
  if (typeof source.text === 'string') return source.text;
  return Array.isArray(source.domains) ? source.domains.join('\n') : null;
}

type ListQuery = z.output<typeof JobListQuery>;

/** Persistence for jobs and items. All SQL uses parameter binding. */
@Injectable()
export class JobStore {
  constructor(private readonly db: Database) {}

  jobRow(id: string): JobRow | undefined {
    return this.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
  }

  requireJobRow(id: string): JobRow {
    const row = this.jobRow(id);
    if (!row) throw AppError.notFound('Job');
    return row;
  }

  job(id: string, options: { includeText?: boolean } = {}): Job {
    return this.toJob(this.requireJobRow(id), options);
  }

  input(row: JobRow): StoredJobInput {
    const input = json.parse<Partial<StoredJobInput>>(row.input_json, {});
    return {
      ...input,
      type: row.type,
      recheck: input.recheck === true,
      summary: { extensions: [], providerIds: [], services: [], checks: [], rows: 0, ...(input.summary ?? {}) },
    };
  }

  /**
   * The restorable input text can be megabytes, so it is only included where a client asks for one
   * job (GET /jobs/:id); lists and events carry `text: null`.
   */
  toJob(row: JobRow, options: { includeText?: boolean } = {}): Job {
    const input = this.input(row);
    return {
      id: row.id,
      type: row.type,
      state: row.state,
      label: row.label,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      updatedAt: row.updated_at,
      counters: countersOf(row),
      destinations: json.parse<string[]>(row.destinations_json, []),
      input: { ...input.summary, text: options.includeText ? restorableText(input) : null, ...inputReading(input) },
      watchId: row.watch_id,
      parentJobId: row.parent_job_id,
      nextRetryAt: row.next_retry_at,
    };
  }

  insertJob(job: {
    id: string;
    type: JobType;
    label: string | null;
    input: StoredJobInput;
    destinations: string[];
    policy: Record<string, unknown>;
    watchId: string | null;
    parentJobId: string | null;
    total: number;
    now: string;
  }) {
    this.db.run(
      `INSERT INTO jobs (id, type, state, label, input_json, destinations_json, policy_json, watch_id, parent_job_id,
         total, pending, running, finished, interrupted, resolved, unresolved, outcomes_json, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, '{}', ?, ?)`,
      [
        job.id,
        job.type,
        job.label,
        json.stringify(job.input),
        json.stringify(job.destinations),
        json.stringify(job.policy),
        job.watchId,
        job.parentJobId,
        job.total,
        job.total,
        job.now,
        job.now,
      ],
    );
  }

  insertItem(item: {
    id: string;
    jobId: string;
    seq: number;
    subject: string;
    unicode: string;
    suffix: string | null;
    operation: JobOperation;
    target: string;
    sourceKey: string;
    now: string;
  }) {
    this.db.run(
      `INSERT INTO job_items (id, job_id, seq, subject, unicode, suffix, operation, target, source_key, state, attempts,
         evidence_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, '{}', ?)`,
      [item.id, item.jobId, item.seq, item.subject, item.unicode, item.suffix, item.operation, item.target, item.sourceKey, item.now],
    );
  }

  saveRun(jobId: string, snap: RunSnapshot, now: string) {
    const c = snap.counters;
    this.db.run(
      `UPDATE jobs SET state = ?, total = ?, pending = ?, running = ?, finished = ?, interrupted = ?, resolved = ?,
         unresolved = ?, outcomes_json = ?, started_at = ?, finished_at = ?, next_retry_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        snap.state,
        c.total,
        c.pending,
        c.running,
        c.finished,
        c.interrupted,
        c.resolved,
        c.unresolved,
        json.stringify(c.outcomes),
        snap.startedAt,
        snap.finishedAt,
        snap.nextRetryAt,
        now,
        jobId,
      ],
    );
  }

  snapshot(row: JobRow): RunSnapshot {
    return {
      state: row.state,
      counters: countersOf(row),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      nextRetryAt: row.next_retry_at,
    };
  }

  /** Counters recomputed from items; used on state transitions (recovery, resume), never per item. */
  recount(jobId: string): { counters: JobCounters; nextRetryAt: string | null } {
    const counters = emptyCounters();
    const rows = this.db.all<{ state: ItemRow['state']; resolved: number; outcome: string | null; n: number }>(
      'SELECT state, resolved, outcome, COUNT(*) AS n FROM job_items WHERE job_id = ? GROUP BY state, resolved, outcome',
      [jobId],
    );
    for (const row of rows) {
      counters.total += row.n;
      counters[row.state] += row.n;
      if (row.state !== 'finished') continue;
      if (row.resolved) counters.resolved += row.n;
      else counters.unresolved += row.n;
      if (row.outcome !== null) counters.outcomes[row.outcome] = (counters.outcomes[row.outcome] ?? 0) + row.n;
    }
    const next = this.db.get<{ at: string | null }>(
      `SELECT MIN(retry_at) AS at FROM job_items WHERE job_id = ? AND state = 'finished' AND resolved = 0 AND retry_at IS NOT NULL`,
      [jobId],
    );
    return { counters, nextRetryAt: next?.at ?? null };
  }

  item(id: string): ItemRow | undefined {
    return this.db.get<ItemRow>('SELECT * FROM job_items WHERE id = ?', [id]);
  }

  /** Jobs newest first with an opaque keyset cursor on (created_at, rowid). */
  list(query: ListQuery): { items: Job[]; nextCursor: string | null; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.type) {
      where.push('type = ?');
      params.push(query.type);
    }
    if (query.state) {
      where.push('state = ?');
      params.push(query.state);
    }
    const total = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM jobs${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
      params,
    )!.n;
    const pageWhere = [...where];
    const pageParams = [...params];
    if (query.cursor) {
      const cursor = decodeCursor<{ c: string; r: number }>(query.cursor);
      if (!cursor || typeof cursor.c !== 'string' || typeof cursor.r !== 'number') throw AppError.invalid('Invalid cursor');
      pageWhere.push('(created_at, rowid) < (?, ?)');
      pageParams.push(cursor.c, cursor.r);
    }
    const rows = this.db.all<JobRow & { _rowid: number }>(
      `SELECT *, rowid AS _rowid FROM jobs${pageWhere.length ? ` WHERE ${pageWhere.join(' AND ')}` : ''}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [...pageParams, query.limit + 1],
    );
    const more = rows.length > query.limit;
    const page = more ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((row) => this.toJob(row)),
      nextCursor: more && last ? encodeCursor({ c: last.created_at, r: last._rowid }) : null,
      total,
    };
  }
}
