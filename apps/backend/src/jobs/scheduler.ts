import { Inject, Injectable, Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import {
  RESOLVED_ITEM_OUTCOMES,
  type Job,
  type JobCounters,
  type JobOperation,
  type JobState,
  type JobType,
  type Settings,
} from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { EventsService } from '../events/events.service.js';
import { Database, json } from '../storage/database.js';
import { EvidenceRepository } from '../storage/evidence.js';
import { SettingsService } from '../system/settings.service.js';
import { JOBS_ENGINE_OPTIONS, type JobsEngineOptions } from './engine-options.js';
import { JobStore, cloneCounters, type ItemEvidenceRefs, type ItemRow, type JobRow, type RunSnapshot, type StoredJobInput } from './job-store.js';
import { JobLifecycleHub } from './lifecycle.js';
import type { JobItemRecord, OperationContext, OperationHandler, OperationResult } from './operation.js';
import { OperationRegistry } from './operation-registry.js';
import { JobResultsService } from './results.service.js';

/** Longest single timer; the scheduler re-evaluates at least this often while work is waiting. */
const MAX_TIMER_MS = 60_000;

interface QueuedItem {
  id: string;
  seq: number;
  subject: string;
  unicode: string;
  suffix: string | null;
  operation: JobOperation;
  target: string;
  /** Completed attempts so far. */
  attempts: number;
  /** Epoch ms before which the item must not start (retry backoff); 0 when ready. */
  notBefore: number;
}

/** Pending items of one job for one source key, loaded from SQLite in small batches. */
interface SourceQueue {
  key: string;
  items: QueuedItem[];
  lastSeq: number;
  exhausted: boolean;
}

/** Shared budget for one source key across every job and watch. */
interface SourceState {
  inFlight: number;
  lastStart: number;
  cooldownUntil: number;
  /** Latest cooldown already written to source_cooldowns (memory can be ahead while a write is pending). */
  persistedUntil: number;
  /** Job that started the latest call, so contended sources rotate between jobs. */
  lastJob: string | null;
}

type AbortKind = 'timeout' | 'cancel' | 'shutdown';

class ItemAbort extends Error {
  constructor(readonly kind: AbortKind) {
    super(`Aborted (${kind})`);
    this.name = 'ItemAbort';
  }
}

interface Cooldown {
  until: number;
  iso: string;
  reason: string;
}

interface InFlight {
  run: JobRun;
  item: QueuedItem;
  sourceKey: string;
  controller: AbortController;
  done: Promise<void>;
  timeoutMs?: number;
}

class JobRun {
  readonly queues = new Map<string, SourceQueue>();
  readonly inFlight = new Set<string>();
  lastProgress = Number.NEGATIVE_INFINITY;

  constructor(
    readonly id: string,
    readonly type: JobType,
    readonly watchId: string | null,
    readonly input: StoredJobInput,
    public snap: RunSnapshot,
  ) {}

  get refs() {
    return { jobId: this.id, watchId: this.watchId };
  }
}

/**
 * Delay before automatic retry `attempt + 1`: exponential from the base, capped, with equal jitter
 * (half fixed, half random) so concurrent retries spread out.
 */
export function backoffDelay(
  attempt: number,
  options: Pick<JobsEngineOptions, 'backoffBaseMs' | 'backoffMaxMs'>,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(options.backoffMaxMs, options.backoffBaseMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

function abortKind(reason: unknown): AbortKind | null {
  return reason instanceof ItemAbort ? reason.kind : null;
}

function isResult(value: unknown): value is OperationResult {
  const r = value as OperationResult | null;
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.outcome === 'string' &&
    r.outcome.length > 0 &&
    typeof r.resolved === 'boolean' &&
    (r.evidence === undefined || Array.isArray(r.evidence))
  );
}

/**
 * The jobs engine: dispatches pending items under shared global and per-source budgets, applies
 * cooldowns and retries, and records every outcome. Handlers only return results; this class writes
 * evidence, the item, job counters and events in one transaction per state change.
 *
 * Fairness: jobs take turns (round robin). Within a job, the lowest input position among sources that
 * may start now goes first, so a busy or cooling source never blocks the others.
 */
@Injectable()
export class JobScheduler {
  private readonly logger = new Logger('JobScheduler');
  private readonly runs = new Map<string, JobRun>();
  private order: string[] = [];
  private cursor = 0;
  private readonly sources = new Map<string, SourceState>();
  private readonly inFlight = new Map<string, InFlight>();
  private globalInFlight = 0;
  private timer: NodeJS.Timeout | null = null;
  private pumpQueued = false;
  private stopping = false;
  private stopRun: Promise<void> | null = null;
  private closed = false;
  /** Completions whose transaction failed; retried by the next pass so no item stays running. */
  private readonly unsaved = new Map<string, { jobId: string; record: () => void }>();
  private lastPrune = 0;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
    private readonly evidence: EvidenceRepository,
    private readonly registry: OperationRegistry,
    private readonly store: JobStore,
    private readonly results: JobResultsService,
    private readonly lifecycle: JobLifecycleHub,
    @Inject(JOBS_ENGINE_OPTIONS) private readonly options: JobsEngineOptions,
  ) {}

  get isStopping(): boolean {
    return this.stopping;
  }

  has(jobId: string): boolean {
    return this.runs.has(jobId);
  }

  /** Shared cooldowns survive restarts so a new process does not ignore a source's Retry-After. */
  loadCooldowns() {
    const rows = this.db.all<{ source_key: string; until: string }>('SELECT source_key, until FROM source_cooldowns WHERE until > ?', [
      this.clock.iso(),
    ]);
    for (const row of rows) {
      const source = this.source(row.source_key);
      source.cooldownUntil = source.persistedUntil = Date.parse(row.until);
    }
  }

  /**
   * Startup recovery: work left active by a previous process becomes interrupted. Resume is explicit.
   * Each job commits on its own, so one failed write does not hold back the others.
   */
  recover(exclude: ReadonlySet<string> = new Set()): Job[] {
    const now = this.clock.iso();
    const rows = this.db
      .all<JobRow>(`SELECT * FROM jobs WHERE state IN ('queued', 'running', 'cancelling') ORDER BY created_at`)
      .filter((row) => !this.runs.has(row.id) && !exclude.has(row.id));
    const recovered: Job[] = [];
    for (const row of rows) {
      try {
        recovered.push(this.recoverJob(row, now));
      } catch (error) {
        this.logger.error(`Could not mark job ${row.id} interrupted: ${(error as Error).message}`);
      }
    }
    return recovered;
  }

  private recoverJob(row: JobRow, now: string): Job {
    return this.db.transaction(() => {
      // The aborted attempt did not complete, so it does not count.
      this.db.run(
        `UPDATE job_items SET state = 'interrupted', attempts = MAX(attempts - 1, 0), updated_at = ?
         WHERE job_id = ? AND state = 'running'`,
        [now, row.id],
      );
      const { counters, nextRetryAt } = this.store.recount(row.id);
      this.store.saveRun(row.id, { state: 'interrupted', counters, startedAt: row.started_at, finishedAt: now, nextRetryAt }, now);
      const job = this.store.job(row.id);
      this.events.emit('job.updated', { jobId: row.id, watchId: row.watch_id }, job);
      return job;
    });
  }

  /** Starts dispatching a persisted queued job. */
  add(jobId: string) {
    if (this.isStopping) throw new AppError('unavailable', 'The backend is stopping', { retryable: true });
    if (this.runs.has(jobId)) return;
    const row = this.store.requireJobRow(jobId);
    const run = new JobRun(row.id, row.type, row.watch_id, this.store.input(row), this.store.snapshot(row));
    const keys = this.db.all<{ source_key: string }>(
      `SELECT DISTINCT source_key FROM job_items WHERE job_id = ? AND state = 'pending'`,
      [jobId],
    );
    for (const { source_key } of keys) run.queues.set(source_key, { key: source_key, items: [], lastSeq: -1, exhausted: false });
    this.runs.set(jobId, run);
    this.order.push(jobId);
    this.schedulePump();
  }

  cancel(jobId: string): Job {
    const row = this.store.requireJobRow(jobId);
    if (row.state === 'cancelled' || row.state === 'cancelling') return this.store.toJob(row);
    if (row.state === 'completed' || row.state === 'completed_with_errors') {
      throw AppError.conflict(`The job already finished (${row.state})`);
    }
    const run = this.runs.get(jobId);
    if (!run) {
      // Interrupted (or left active without a run): nothing is in flight, so it is cancelled directly.
      const now = this.clock.iso();
      const snap = this.store.snapshot(row);
      this.db.transaction(() => {
        this.store.saveRun(jobId, { ...snap, state: 'cancelled', finishedAt: snap.finishedAt ?? now }, now);
        this.events.emit('job.updated', { jobId, watchId: row.watch_id }, this.store.job(jobId));
      });
      return this.store.job(jobId);
    }
    this.commit(run, { ...run.snap, state: 'cancelling' }, true);
    for (const id of run.inFlight) this.inFlight.get(id)?.controller.abort(new ItemAbort('cancel'));
    this.safeFinalize(run);
    return this.store.job(jobId);
  }

  resume(jobId: string): Job {
    const row = this.store.requireJobRow(jobId);
    if (this.runs.has(jobId) || (row.state !== 'cancelled' && row.state !== 'interrupted')) {
      throw AppError.conflict(`Only cancelled or interrupted jobs can be resumed; this job is ${row.state}`);
    }
    if (this.isStopping) throw new AppError('unavailable', 'The backend is stopping', { retryable: true });
    const operations = this.db.all<{ operation: JobOperation }>(
      `SELECT DISTINCT operation FROM job_items WHERE job_id = ? AND state IN ('pending', 'interrupted', 'running')`,
      [jobId],
    );
    for (const { operation } of operations) {
      if (!this.registry.get(operation)) {
        throw new AppError('unavailable', `No handler is registered for the ${operation} operation`, { retryable: true });
      }
    }
    const now = this.clock.iso();
    this.db.transaction(() => {
      // Finished items and their check times stay as they are; only unfinished work runs again.
      this.db.run(
        `UPDATE job_items SET state = 'pending', not_before = NULL, updated_at = ?
         WHERE job_id = ? AND state IN ('pending', 'interrupted', 'running')`,
        [now, jobId],
      );
      const { counters, nextRetryAt } = this.store.recount(jobId);
      this.store.saveRun(jobId, { state: 'queued', counters, startedAt: row.started_at, finishedAt: null, nextRetryAt }, now);
      this.events.emit('job.updated', { jobId, watchId: row.watch_id }, this.store.job(jobId));
    });
    this.add(jobId);
    return this.store.job(jobId);
  }

  /**
   * Graceful stop: no new dispatch; in-flight calls may finish until `signal` aborts (the stop
   * deadline), then they are aborted and recorded as interrupted. Active jobs become interrupted
   * (cancelling ones cancelled). Idempotent.
   */
  stop(signal?: AbortSignal): Promise<void> {
    if (!this.stopRun) {
      // Both are set before the body runs: it notifies listeners, which must neither admit work nor
      // start a second stop.
      this.stopping = true;
      this.stopRun = Promise.resolve().then(() => this.runStop(signal));
    }
    return this.stopRun;
  }

  private async runStop(signal?: AbortSignal): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = [...this.inFlight.values()].map((entry) => entry.done);
    if (pending.length > 0) {
      const abortAll = () => {
        for (const entry of this.inFlight.values()) entry.controller.abort(new ItemAbort('shutdown'));
      };
      if (!signal || signal.aborted) abortAll();
      else signal.addEventListener('abort', abortAll, { once: true });
      await Promise.allSettled(pending);
    }
    // Results already returned by handlers are kept rather than repeated after resume, and a job
    // they complete finishes normally instead of being marked interrupted.
    this.flushUnsaved();
    this.unsaved.clear();
    for (const run of [...this.runs.values()]) this.safeFinalize(run);
    const tracked = new Set(this.runs.keys());
    const now = this.clock.iso();
    for (const run of [...this.runs.values()]) {
      try {
        const state: JobState = run.snap.state === 'cancelling' ? 'cancelled' : 'interrupted';
        const job = this.db.transaction(() => {
          this.db.run(
            `UPDATE job_items SET state = 'interrupted', attempts = MAX(attempts - 1, 0), updated_at = ?
             WHERE job_id = ? AND state = 'running'`,
            [now, run.id],
          );
          const { counters, nextRetryAt } = this.store.recount(run.id);
          this.store.saveRun(run.id, { state, counters, startedAt: run.snap.startedAt, finishedAt: now, nextRetryAt }, now);
          const updated = this.store.job(run.id);
          this.events.emit('job.updated', run.refs, updated);
          return updated;
        });
        this.lifecycle.notify(job);
      } catch (error) {
        this.logger.error(`Could not record interrupted job ${run.id}: ${(error as Error).message}`);
      }
    }
    this.runs.clear();
    this.order = [];
    // Jobs committed but never admitted (submitted inside a caller transaction) are interrupted too.
    // Tracked jobs whose write failed above are left for startup recovery rather than relabeled here.
    try {
      for (const job of this.recover(tracked)) this.lifecycle.notify(job);
    } catch (error) {
      this.logger.error(`Could not record jobs awaiting admission: ${(error as Error).message}`);
    }
    this.closed = true;
  }

  /** Re-evaluates budgets now, e.g. after concurrency settings changed. */
  wake() {
    this.schedulePump();
  }

  // Dispatch

  private schedulePump() {
    if (this.pumpQueued || this.isStopping) return;
    this.pumpQueued = true;
    setImmediate(() => this.pump());
  }

  private arm(delayMs: number) {
    if (this.isStopping) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.pump();
      },
      Math.max(0, Math.min(Math.ceil(delayMs), MAX_TIMER_MS)),
    );
    this.timer.unref?.();
  }

  private pump() {
    this.pumpQueued = false;
    if (this.isStopping) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      const settings = this.settings.get();
      const now = this.clock.now().getTime();
      let wakeAt = Number.POSITIVE_INFINITY;
      if (!this.flushUnsaved()) wakeAt = now + 1000;
      this.pruneSources(now, settings);
      while (this.globalInFlight < settings.concurrency.global && this.order.length > 0) {
        let dispatched = false;
        const count = this.order.length;
        for (let n = 0; n < count && !dispatched; n++) {
          const index = (this.cursor + n) % count;
          const run = this.runs.get(this.order[index]!);
          if (!run || run.snap.state === 'cancelling') continue;
          const pick = this.pick(run, now, settings);
          if (typeof pick === 'number') {
            wakeAt = Math.min(wakeAt, pick);
            continue;
          }
          this.cursor = (index + 1) % count;
          const turn = this.sourceTurn(run, pick, now);
          this.dispatch(turn.run, turn.queue, turn.index);
          dispatched = true;
        }
        if (!dispatched) break;
      }
      for (const run of [...this.runs.values()]) this.safeFinalize(run);
      if (wakeAt < Number.POSITIVE_INFINITY) this.arm(wakeAt - now);
    } catch (error) {
      this.logger.error(`Scheduler pass failed: ${(error as Error).message}`, (error as Error).stack);
      this.arm(1000);
    }
  }

  /** Next item of `run` that may start now, or the earliest time one might. */
  private pick(run: JobRun, now: number, settings: Settings): { queue: SourceQueue; index: number } | number {
    let best: { queue: SourceQueue; index: number; seq: number } | null = null;
    let wakeAt = Number.POSITIVE_INFINITY;
    const maxWaitMs = settings.concurrency.maxCooldownWaitSeconds * 1000;
    for (const queue of [...run.queues.values()]) {
      if (queue.items.length === 0 && queue.exhausted) {
        run.queues.delete(queue.key);
        continue;
      }
      const source = queue.key === '' ? null : this.source(queue.key);
      if (source) {
        if (source.cooldownUntil - now > maxWaitMs) {
          if (this.sweep(run, queue, source)) wakeAt = now;
          continue;
        }
        // A busy source wakes the scheduler when its call completes.
        if (source.inFlight >= settings.concurrency.perSource) continue;
        const sourceAt = Math.max(source.lastStart + settings.concurrency.minSourceIntervalMs, source.cooldownUntil);
        if (sourceAt > now) {
          wakeAt = Math.min(wakeAt, sourceAt);
          continue;
        }
      }
      const ready = this.readyIndex(run, queue, now);
      if (ready.index < 0) {
        if (queue.items.length === 0 && queue.exhausted) run.queues.delete(queue.key);
        else wakeAt = Math.min(wakeAt, ready.wakeAt);
        continue;
      }
      const seq = queue.items[ready.index]!.seq;
      if (!best || seq < best.seq) best = { queue, index: ready.index, seq };
    }
    return best ?? wakeAt;
  }

  /**
   * Per-source turns: a free source goes to the next job after the one that used it last that has a
   * ready item for it, so one job's turns on other sources cannot crowd others off a shared source.
   */
  private sourceTurn(run: JobRun, pick: { queue: SourceQueue; index: number }, now: number): { run: JobRun; queue: SourceQueue; index: number } {
    const key = pick.queue.key;
    const count = this.order.length;
    if (key === '' || count < 2) return { run, ...pick };
    const last = this.source(key).lastJob;
    const start = last === null ? -1 : this.order.indexOf(last);
    for (let n = 1; n <= count; n++) {
      const other = this.runs.get(this.order[(start + n) % count]!);
      if (!other || other.snap.state === 'cancelling') continue;
      if (other === run) break;
      const queue = other.queues.get(key);
      if (!queue) continue;
      const ready = this.readyIndex(other, queue, now);
      if (ready.index >= 0) return { run: other, queue, index: ready.index };
    }
    return { run, ...pick };
  }

  private readyIndex(run: JobRun, queue: SourceQueue, now: number): { index: number; wakeAt: number } {
    for (;;) {
      let wakeAt = Number.POSITIVE_INFINITY;
      for (let i = 0; i < queue.items.length; i++) {
        const notBefore = queue.items[i]!.notBefore;
        if (notBefore <= now) return { index: i, wakeAt: now };
        wakeAt = Math.min(wakeAt, notBefore);
      }
      // Items waiting on backoff leave the source idle: look further down the same source.
      if (!this.load(run, queue)) return { index: -1, wakeAt };
    }
  }

  private load(run: JobRun, queue: SourceQueue): boolean {
    if (queue.exhausted || queue.items.length >= this.options.maxBuffered) return false;
    const rows = this.db.all<ItemRow>(
      `SELECT id, seq, subject, unicode, suffix, operation, target, attempts, not_before FROM job_items
       WHERE job_id = ? AND source_key = ? AND state = 'pending' AND seq > ? ORDER BY seq LIMIT ?`,
      [run.id, queue.key, queue.lastSeq, this.options.batchSize],
    );
    if (rows.length < this.options.batchSize) queue.exhausted = true;
    if (rows.length === 0) return false;
    queue.lastSeq = rows[rows.length - 1]!.seq;
    // A requeued retry can already be buffered after a sweep reset this queue's cursor.
    const buffered = new Set(queue.items.map((i) => i.id));
    for (const row of rows) {
      if (buffered.has(row.id) || this.inFlight.has(row.id)) continue;
      queue.items.push({
        id: row.id,
        seq: row.seq,
        subject: row.subject,
        unicode: row.unicode,
        suffix: row.suffix,
        operation: row.operation,
        target: row.target,
        attempts: row.attempts,
        notBefore: row.not_before ? Date.parse(row.not_before) : 0,
      });
    }
    if (buffered.size > 0) queue.items.sort((a, b) => a.seq - b.seq);
    return true;
  }

  private dispatch(run: JobRun, queue: SourceQueue, index: number) {
    const item = queue.items[index];
    if (!item) return;
    const attempt = item.attempts + 1;
    const now = this.clock.iso();
    const next: RunSnapshot = { ...run.snap, counters: cloneCounters(run.snap.counters) };
    next.counters.pending -= 1;
    next.counters.running += 1;
    const started = next.state === 'queued';
    if (started) {
      next.state = 'running';
      next.startedAt ??= now;
    }
    this.commit(run, next, started, () => {
      this.db.run(
        `UPDATE job_items SET state = 'running', attempts = ?, started_at = ?, not_before = NULL, updated_at = ? WHERE id = ?`,
        [attempt, now, now, item.id],
      );
    });
    // Only after the commit: a failed transaction leaves the item buffered for the next pass.
    queue.items.splice(index, 1);
    if (queue.key !== '') {
      const source = this.source(queue.key);
      source.inFlight += 1;
      source.lastStart = this.clock.now().getTime();
      source.lastJob = run.id;
    }
    this.globalInFlight += 1;
    const entry = { run, item, sourceKey: queue.key, controller: new AbortController() } as InFlight;
    this.inFlight.set(item.id, entry);
    run.inFlight.add(item.id);
    entry.done = this.execute(entry, this.registry.get(item.operation), attempt).catch((error: unknown) => {
      this.logger.error(`Item ${item.id} failed outside the handler: ${(error as Error).message}`);
    });
  }

  private async execute(entry: InFlight, handler: OperationHandler | undefined, attempt: number): Promise<void> {
    const { run, item, controller } = entry;
    const settings = this.settings.get();
    let limit = settings.retries.timeoutMs;
    try {
      limit = handler?.timeoutMs?.(this.record(run, item), settings) ?? limit;
    } catch {
      // A failing hook keeps the default limit; execution errors surface below.
    }
    entry.timeoutMs = limit;
    const timer = setTimeout(() => controller.abort(new ItemAbort('timeout')), limit);
    let settled: { result: unknown } | { error: unknown };
    try {
      if (!handler) throw new Error(`No handler is registered for the ${item.operation} operation`);
      const record = this.record(run, item);
      const ctx: OperationContext = {
        signal: controller.signal,
        attempt,
        settings,
        now: () => this.clock.now(),
        allowCache: run.input.recheck !== true,
      };
      const work = Promise.resolve().then(() => {
        // Spacing counts from the real request start, which can trail dispatch by other synchronous work.
        if (entry.sourceKey !== '') this.source(entry.sourceKey).lastStart = this.clock.now().getTime();
        return handler.execute(record, ctx);
      });
      // Settles as soon as the call is aborted, even if a handler ignores its signal.
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => reject(controller.signal.reason);
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      work.catch(() => undefined);
      aborted.catch(() => undefined);
      settled = { result: await Promise.race([work, aborted]) };
    } catch (error) {
      settled = { error };
    } finally {
      clearTimeout(timer);
    }
    this.complete(entry, attempt, settled, settings);
  }

  private complete(entry: InFlight, attempt: number, settled: { result: unknown } | { error: unknown }, settings: Settings) {
    const { run, item, sourceKey, controller } = entry;
    this.inFlight.delete(item.id);
    run.inFlight.delete(item.id);
    this.globalInFlight -= 1;
    if (sourceKey !== '') {
      const source = this.source(sourceKey);
      source.inFlight = Math.max(0, source.inFlight - 1);
    }
    if (this.closed) return;
    const kind = controller.signal.aborted ? abortKind(controller.signal.reason) : null;
    // A deferred retry of this record replays the decision as of when the response arrived.
    const receivedAt = this.clock.now().getTime();
    const record =
      kind === 'cancel' || kind === 'shutdown'
        ? () => this.interruptItem(run, item, attempt)
        : (() => {
            const result = this.normalize(item, settled, kind, settings, entry.timeoutMs);
            return () => this.applyResult(run, entry, attempt, result, receivedAt);
          })();
    try {
      record();
    } catch (error) {
      // Nothing was committed; keep the outcome (never call the handler again) and retry the write.
      this.logger.error(`Could not record item ${item.id}: ${(error as Error).message}`);
      this.unsaved.set(item.id, { jobId: run.id, record });
      this.arm(1000);
    }
    this.safeFinalize(run);
    this.schedulePump();
  }

  /** Retries failed completion writes. Returns false while some still fail. */
  private flushUnsaved(): boolean {
    let allSaved = true;
    for (const [id, { record }] of [...this.unsaved]) {
      try {
        record();
        this.unsaved.delete(id);
      } catch (error) {
        this.logger.error(`Could not record item ${id}: ${(error as Error).message}`);
        allSaved = false;
      }
    }
    return allSaved;
  }

  private safeFinalize(run: JobRun) {
    try {
      this.maybeFinalize(run);
    } catch (error) {
      this.logger.error(`Could not finish job ${run.id}: ${(error as Error).message}`);
      this.arm(1000);
    }
  }

  /** Drops budget state for idle sources (e.g. one host key per diagnosed domain) once no limit applies. */
  private pruneSources(now: number, settings: Settings) {
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    const idleAfter = Math.max(60_000, settings.concurrency.minSourceIntervalMs);
    for (const [key, source] of this.sources) {
      if (source.inFlight === 0 && source.cooldownUntil <= now && now - source.lastStart > idleAfter) this.sources.delete(key);
    }
  }

  private normalize(
    item: QueuedItem,
    settled: { result: unknown } | { error: unknown },
    kind: AbortKind | null,
    settings: Settings,
    timeoutMs = settings.retries.timeoutMs,
  ): OperationResult {
    if ('result' in settled) {
      if (isResult(settled.result)) return { ...settled.result, evidence: settled.result.evidence ?? [] };
      this.logger.warn(`Handler for ${item.operation} returned an invalid result`);
      return {
        outcome: 'error',
        resolved: false,
        evidence: [],
        error: { code: 'internal', message: 'The handler returned an invalid result', retryable: false },
        retryable: false,
      };
    }
    if (kind === 'timeout') {
      return {
        outcome: 'timeout',
        resolved: false,
        evidence: [],
        error: { code: 'timeout', message: `No response within ${timeoutMs} ms`, retryable: true },
        retryable: true,
      };
    }
    // Thrown errors may carry upstream URLs, so only the error class reaches stored results.
    const error = settled.error as Error | undefined;
    this.logger.warn(`Handler for ${item.operation} threw: ${error?.message ?? String(settled.error)}`);
    return {
      outcome: 'error',
      resolved: false,
      evidence: [],
      error: { code: 'internal', message: `The ${item.operation} operation failed (${error?.name ?? 'Error'})`, retryable: true },
      retryable: true,
    };
  }

  private applyResult(run: JobRun, entry: InFlight, attempt: number, result: OperationResult, receivedAt: number) {
    const { item, sourceKey } = entry;
    const settings = this.settings.get();
    const now = receivedAt;
    const cooldown = sourceKey === '' ? null : this.cooldownFrom(result, now);
    const longCooldown = cooldown !== null && cooldown.until - now > settings.concurrency.maxCooldownWaitSeconds * 1000;
    // Honor the source's request even if the writes below fail and are retried later.
    if (cooldown) this.reserveCooldown(sourceKey, cooldown);
    // RESOLVED_ITEM_OUTCOMES is authoritative: unsupported or credential_required are not answers.
    const resolved = RESOLVED_ITEM_OUTCOMES[item.operation].includes(result.outcome);
    if (result.resolved !== resolved) {
      this.logger.warn(`Handler for ${item.operation} reported resolved=${result.resolved} for outcome ${result.outcome}`);
    }
    if (
      !resolved &&
      result.retryable === true &&
      attempt < settings.retries.maxAttempts &&
      !longCooldown &&
      run.snap.state !== 'cancelling'
    ) {
      const notBefore = Math.max(now + this.backoff(attempt), cooldown?.until ?? 0);
      this.requeue(run, entry, attempt, result, notBefore, cooldown);
      return;
    }
    const retryAt = resolved ? null : (result.retryAt ?? cooldown?.iso ?? null);
    try {
      try {
        this.finishItem(run, entry, attempt, { ...result, resolved }, retryAt, cooldown);
      } catch {
        // One immediate retry absorbs a passing write failure without discarding a valid result.
        this.finishItem(run, entry, attempt, { ...result, resolved }, retryAt, cooldown);
      }
    } catch (error) {
      // Evidence that cannot be stored (constraint or shape errors) must not leave the item running.
      this.logger.error(`Could not store evidence for item ${item.id}: ${(error as Error).message}`);
      this.finishItem(
        run,
        entry,
        attempt,
        {
          outcome: 'error',
          resolved: false,
          evidence: [],
          error: { code: 'internal', message: 'The result could not be stored', retryable: true },
        },
        null,
        cooldown,
      );
    }
  }

  private cooldownFrom(result: OperationResult, now: number): Cooldown | null {
    if (!result.cooldownUntil) return null;
    const until = Date.parse(result.cooldownUntil);
    if (!Number.isFinite(until) || until <= now) return null;
    return { until, iso: new Date(until).toISOString(), reason: result.error?.code ?? result.outcome };
  }

  private backoff(attempt: number): number {
    return backoffDelay(attempt, this.options);
  }

  private requeue(run: JobRun, entry: InFlight, attempt: number, result: OperationResult, notBefore: number, cooldown: Cooldown | null) {
    const { item, sourceKey } = entry;
    const now = this.clock.iso();
    const next: RunSnapshot = { ...run.snap, counters: cloneCounters(run.snap.counters) };
    next.counters.running -= 1;
    next.counters.pending += 1;
    this.commit(run, next, false, () => {
      // Evidence of an attempt that will be retried is not kept; the final attempt's evidence is.
      this.db.run(
        `UPDATE job_items SET state = 'pending', attempts = ?, not_before = ?, error_json = ?, updated_at = ? WHERE id = ?`,
        [attempt, new Date(notBefore).toISOString(), result.error ? json.stringify(result.error) : null, now, item.id],
      );
      if (cooldown) this.persistCooldown(run, sourceKey, cooldown, now);
      this.progress(run, next.counters);
    });
    if (cooldown) this.rememberCooldown(sourceKey, cooldown);
    item.attempts = attempt;
    item.notBefore = notBefore;
    let queue = run.queues.get(sourceKey);
    if (!queue) {
      queue = { key: sourceKey, items: [], lastSeq: Number.MAX_SAFE_INTEGER, exhausted: true };
      run.queues.set(sourceKey, queue);
    }
    const at = queue.items.findIndex((other) => other.seq > item.seq);
    queue.items.splice(at < 0 ? queue.items.length : at, 0, item);
  }

  private finishItem(
    run: JobRun,
    entry: InFlight,
    attempt: number,
    result: OperationResult,
    retryAt: string | null,
    cooldown: Cooldown | null,
  ) {
    const { item, sourceKey } = entry;
    const now = this.clock.iso();
    const next: RunSnapshot = { ...run.snap, counters: cloneCounters(run.snap.counters) };
    const c = next.counters;
    c.running -= 1;
    c.finished += 1;
    if (result.resolved) c.resolved += 1;
    else c.unresolved += 1;
    c.outcomes[result.outcome] = (c.outcomes[result.outcome] ?? 0) + 1;
    if (retryAt && (!next.nextRetryAt || retryAt < next.nextRetryAt)) next.nextRetryAt = retryAt;
    this.commit(run, next, false, () => {
      let registryId: string | null = null;
      const observations: string[] = [];
      const offers: string[] = [];
      for (const evidence of result.evidence) {
        if (evidence.kind === 'observation') {
          this.evidence.insertObservation(evidence.row);
          if (evidence.row.kind === 'registry' && registryId === null) registryId = evidence.row.id;
          else observations.push(evidence.row.id);
        } else {
          this.evidence.insertOffer(evidence.row);
          offers.push(evidence.row.id);
        }
      }
      const refs: ItemEvidenceRefs = {};
      if (registryId === null && result.reused?.registryObservationId) {
        registryId = result.reused.registryObservationId;
        refs.reusedRegistry = true;
      }
      observations.push(...(result.reused?.observationIds ?? []));
      if (observations.length) refs.observations = observations;
      if (offers.length) refs.offers = offers;
      this.db.run(
        `UPDATE job_items SET state = 'finished', attempts = ?, outcome = ?, resolved = ?, error_json = ?, retry_at = ?,
           not_before = NULL, registry_observation_id = ?, evidence_json = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`,
        [
          attempt,
          result.outcome,
          result.resolved ? 1 : 0,
          result.error ? json.stringify(result.error) : null,
          retryAt,
          registryId,
          json.stringify(refs),
          now,
          now,
          item.id,
        ],
      );
      if (cooldown) this.persistCooldown(run, sourceKey, cooldown, now);
      const [observed] = this.results.byIds([item.id]);
      if (observed) {
        this.events.emit('result.observed', run.refs, observed);
        for (const offer of observed.evidence.offers) {
          if (offer.kind === 'exact_quote') this.events.emit('quote.observed', run.refs, offer);
        }
      }
      this.progress(run, next.counters);
    });
    if (cooldown) this.rememberCooldown(sourceKey, cooldown);
  }

  private interruptItem(run: JobRun, item: QueuedItem, attempt: number) {
    const now = this.clock.iso();
    const next: RunSnapshot = { ...run.snap, counters: cloneCounters(run.snap.counters) };
    next.counters.running -= 1;
    next.counters.interrupted += 1;
    this.commit(run, next, false, () => {
      // The aborted attempt did not complete, so it does not count against retries.
      this.db.run(`UPDATE job_items SET state = 'interrupted', attempts = ?, updated_at = ? WHERE id = ?`, [attempt - 1, now, item.id]);
    });
  }

  /**
   * A source asked to wait longer than the configured maximum: settle this job's pending items for it
   * as unresolved with retryAt instead of holding the job open. Returns true when more remain.
   */
  private sweep(run: JobRun, queue: SourceQueue, source: SourceState): boolean {
    const rows = this.db.all<ItemRow>(
      `SELECT * FROM job_items WHERE job_id = ? AND source_key = ? AND state = 'pending' ORDER BY seq LIMIT ?`,
      [run.id, queue.key, this.options.sweepBatchSize],
    );
    queue.items = [];
    queue.lastSeq = -1;
    queue.exhausted = false;
    if (rows.length === 0) {
      run.queues.delete(queue.key);
      return false;
    }
    const now = this.clock.iso();
    const until = new Date(source.cooldownUntil).toISOString();
    const next: RunSnapshot = { ...run.snap, counters: cloneCounters(run.snap.counters) };
    const c = next.counters;
    c.pending -= rows.length;
    c.finished += rows.length;
    c.unresolved += rows.length;
    c.outcomes.rate_limited = (c.outcomes.rate_limited ?? 0) + rows.length;
    if (!next.nextRetryAt || until < next.nextRetryAt) next.nextRetryAt = until;
    const started = next.state === 'queued';
    if (started) {
      next.state = 'running';
      next.startedAt ??= now;
    }
    const error = json.stringify({
      code: 'source_cooldown',
      message: `${queue.key} asked to wait until ${until}; not queried`,
      retryable: true,
    });
    this.commit(run, next, started, () => {
      for (const row of rows) {
        this.db.run(
          `UPDATE job_items SET state = 'finished', outcome = 'rate_limited', resolved = 0, error_json = ?, retry_at = ?,
             not_before = NULL, finished_at = ?, updated_at = ? WHERE id = ?`,
          [error, until, now, now, row.id],
        );
      }
      for (const observed of this.results.byIds(rows.map((r) => r.id))) this.events.emit('result.observed', run.refs, observed);
      this.progress(run, next.counters);
    });
    return rows.length === this.options.sweepBatchSize;
  }

  private persistCooldown(run: JobRun, key: string, cooldown: Cooldown, now: string) {
    if (cooldown.until <= this.source(key).persistedUntil) return;
    this.db.run(
      `INSERT INTO source_cooldowns (source_key, until, reason, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(source_key) DO UPDATE SET until = excluded.until, reason = excluded.reason, updated_at = excluded.updated_at`,
      [key, cooldown.iso, cooldown.reason, now],
    );
    this.events.emit('source.cooldown', run.refs, { sourceId: key, until: cooldown.iso, reason: cooldown.reason });
  }

  /** After a committed write: the cooldown is durable and applies to scheduling. */
  private rememberCooldown(key: string, cooldown: Cooldown) {
    const source = this.source(key);
    source.persistedUntil = Math.max(source.persistedUntil, cooldown.until);
    this.reserveCooldown(key, cooldown);
  }

  /** Applies a cooldown to scheduling before it is durable (its write failed and will be retried). */
  private reserveCooldown(key: string, cooldown: Cooldown) {
    const source = this.source(key);
    source.cooldownUntil = Math.max(source.cooldownUntil, cooldown.until);
  }

  private maybeFinalize(run: JobRun) {
    if (this.closed || !this.runs.has(run.id) || run.inFlight.size > 0) return;
    for (const pending of this.unsaved.values()) if (pending.jobId === run.id) return;
    const snap = run.snap;
    let state: JobState | null = null;
    if (snap.state === 'cancelling') state = 'cancelled';
    else if (snap.counters.pending === 0 && snap.counters.running === 0 && snap.counters.interrupted === 0) {
      // Interrupted items outside a cancel come from a stop; runStop records the job as interrupted.
      state = snap.counters.unresolved > 0 ? 'completed_with_errors' : 'completed';
    }
    if (!state) return;
    const now = this.clock.iso();
    this.commit(run, { ...snap, state, startedAt: snap.startedAt ?? now, finishedAt: now }, true);
    this.remove(run.id);
    this.lifecycle.notify(this.store.job(run.id));
  }

  private remove(jobId: string) {
    const index = this.order.indexOf(jobId);
    this.runs.delete(jobId);
    if (index < 0) return;
    this.order.splice(index, 1);
    if (this.cursor > index) this.cursor -= 1;
    if (this.cursor >= this.order.length) this.cursor = 0;
  }

  /** Persists `next` (plus `write`) in one transaction; memory changes only after commit. */
  private commit(run: JobRun, next: RunSnapshot, emitUpdated: boolean, write?: () => void) {
    const now = this.clock.iso();
    this.db.transaction(() => {
      write?.();
      this.store.saveRun(run.id, next, now);
      if (emitUpdated) this.events.emit('job.updated', run.refs, this.store.job(run.id));
    });
    run.snap = next;
  }

  private progress(run: JobRun, counters: JobCounters) {
    const t = performance.now();
    if (t - run.lastProgress < this.options.progressIntervalMs) return;
    run.lastProgress = t;
    this.events.emit('job.progress', run.refs, { jobId: run.id, counters });
  }

  private source(key: string): SourceState {
    let state = this.sources.get(key);
    if (!state) {
      state = { inFlight: 0, lastStart: Number.NEGATIVE_INFINITY, cooldownUntil: 0, persistedUntil: 0, lastJob: null };
      this.sources.set(key, state);
    }
    return state;
  }

  private record(run: JobRun, item: QueuedItem): JobItemRecord {
    return {
      id: item.id,
      jobId: run.id,
      jobType: run.type,
      seq: item.seq,
      subject: item.subject,
      unicode: item.unicode,
      suffix: item.suffix,
      operation: item.operation,
      target: item.target,
      attempts: item.attempts,
      jobInput: run.input,
    };
  }
}
