import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TERMINAL_JOB_STATES, type Job } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { APP_CONFIG, type AppConfig } from '../core/config.js';
import { AppError } from '../core/errors.js';
import { JobLifecycle, JobSubmitter, type WatchJobRequest } from '../core/ports.js';
import { Database } from '../storage/database.js';
import { ChangeDetector } from './change-detector.service.js';
import { MINUTE_MS, addMinutes, toRecord, type WatchRecord, type WatchRow } from './watch-records.js';
import { WatchesService } from './watches.service.js';

export const WATCH_TICK_MS = 30_000;

const ACTIVE_RUN = `status IN ('running', 'catch_up')`;

type RunKind = 'scheduled' | 'manual' | 'catch_up';

interface RunRow {
  id: string;
  watch_id: string;
  status: string;
  job_id: string | null;
  changes: number;
  note: string | null;
}

/**
 * Runs due watches through the jobs engine, so source budgets and cooldowns apply automatically.
 *
 * The timer only wakes `tick()`; all scheduling state is in SQLite, so tests drive `tick()` with a
 * FakeClock. On startup, intervals that fell due while the backend was stopped are recorded as one
 * `missed` run row and at most one catch-up run is started per watch.
 */
@Injectable()
export class WatchScheduler implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Monitoring');
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly watches: WatchesService,
    private readonly detector: ChangeDetector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly submitter?: JobSubmitter,
    @Optional() private readonly lifecycle?: JobLifecycle,
  ) {}

  /** Registered during init so jobs the engine recovers as interrupted at startup are reported too. */
  onModuleInit() {
    this.unsubscribe = this.lifecycle?.onFinished((job) => this.safely(() => this.onJobFinished(job))) ?? null;
  }

  onApplicationBootstrap() {
    this.safely(() => this.recoverAfterDowntime());
    if (!this.config.embedded) {
      this.timer = setInterval(() => this.safely(() => this.tick()), WATCH_TICK_MS);
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Start every due active watch that has no run in progress. Returns the started job ids. */
  tick(): string[] {
    this.reconcileActiveRuns();
    const now = this.clock.iso();
    const due = this.db.all<WatchRow>(
      `SELECT * FROM watches WHERE state = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id`,
      [now],
    );
    const started: string[] = [];
    for (const row of due) {
      const watch = toRecord(row);
      if (this.hasActiveRun(watch.id)) continue;
      const job = this.start(watch, 'scheduled', watch.nextRunAt!, nextSlotAfter(watch.nextRunAt!, watch.intervalMinutes, now));
      if (job) started.push(job.id);
    }
    return started;
  }

  /**
   * POST /watches/:id/run. Works for paused watches too and does not change the pause state.
   * A repeated Idempotency-Key returns the job of the run it started, even while it is in progress.
   */
  runNow(watchId: string, idempotencyKey?: string): Job {
    const watch = this.watches.record(watchId);
    if (!this.submitter) throw new AppError('unavailable', 'The job engine is not available');
    if (idempotencyKey) {
      const previous = this.db.get<{ job_id: string | null }>(
        'SELECT job_id FROM watch_runs WHERE watch_id = ? AND idempotency_key = ? AND job_id IS NOT NULL ORDER BY started_at DESC LIMIT 1',
        [watchId, idempotencyKey],
      );
      if (previous?.job_id) return this.submitter.get(previous.job_id);
    }
    this.reconcileActiveRuns();
    if (this.hasActiveRun(watchId)) throw AppError.conflict('A run for this watch is already in progress');
    const now = this.clock.iso();
    const next = watch.state === 'active' ? addMinutes(now, watch.intervalMinutes) : null;
    return this.start(watch, 'manual', now, next, { throwOnError: true, idempotencyKey })!;
  }

  /**
   * Startup recovery: close runs left over from the previous process, record intervals missed
   * while stopped, and start at most one catch-up run per overdue watch.
   */
  recoverAfterDowntime() {
    const now = this.clock.iso();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE watch_runs SET status = 'cancelled', finished_at = ?,
           note = TRIM(IFNULL(note || ' ', '') || 'The backend stopped before this run finished.')
         WHERE ${ACTIVE_RUN}`,
        [now],
      );
    });
    const overdue = this.db.all<WatchRow>(
      `SELECT * FROM watches WHERE state = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id`,
      [now],
    );
    for (const row of overdue) {
      const watch = toRecord(row);
      const first = watch.nextRunAt!;
      const intervalMs = watch.intervalMinutes * MINUTE_MS;
      const missed = Math.floor((Date.parse(now) - Date.parse(first)) / intervalMs) + 1;
      const last = new Date(Date.parse(first) + (missed - 1) * intervalMs).toISOString();
      this.db.transaction(() => {
        this.db.run(
          `INSERT INTO watch_runs (id, watch_id, status, scheduled_for, started_at, finished_at, job_id, changes, failures, note)
           VALUES (?, ?, 'missed', ?, NULL, NULL, NULL, 0, 0, ?)`,
          [
            randomUUID(),
            watch.id,
            first,
            missed === 1
              ? `1 scheduled check was due at ${first} while the backend was stopped.`
              : `${missed} scheduled checks were due from ${first} to ${last} while the backend was stopped.`,
          ],
        );
        this.db.run('UPDATE watches SET missed_runs = ? WHERE id = ?', [missed, watch.id]);
        this.watches.changed(watch.id);
      });
      this.start({ ...watch, missedRuns: missed }, 'catch_up', now, addMinutes(last, watch.intervalMinutes));
    }
  }

  /** Called by the jobs engine after a watch job reaches a terminal state. */
  onJobFinished(job: Job) {
    if (!job.watchId || !TERMINAL_JOB_STATES.includes(job.state)) return;
    const watch = this.watches.find(job.watchId);
    if (!watch) return;
    const now = this.clock.iso();
    this.db.transaction(() => {
      const notices = this.detector.detect(watch, job.id);
      const status =
        job.state === 'completed' ? 'completed' : job.state === 'completed_with_errors' ? 'completed_with_errors' : 'cancelled';
      const failures = job.counters.unresolved + job.counters.interrupted;
      const note = job.state === 'interrupted' ? 'The job was interrupted before every item finished.' : null;
      const runs = this.db.all<RunRow>('SELECT * FROM watch_runs WHERE job_id = ? ORDER BY started_at DESC, id', [job.id]);
      if (runs.length) {
        // A resumed job can finish more than once; changes accumulate on its first run row.
        runs.forEach((run, index) => {
          this.db.run(
            `UPDATE watch_runs SET status = ?, finished_at = ?, changes = changes + ?, failures = ?, note = ? WHERE id = ?`,
            [status, job.finishedAt ?? now, index === 0 ? notices.length : 0, failures, joinNotes(run.note, note), run.id],
          );
        });
      } else {
        this.db.run(
          `INSERT INTO watch_runs (id, watch_id, status, scheduled_for, started_at, finished_at, job_id, changes, failures, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [randomUUID(), watch.id, status, job.createdAt, job.startedAt, job.finishedAt ?? now, job.id, notices.length, failures, note],
        );
      }
      this.watches.changed(watch.id, job.id);
    });
  }

  private start(
    watch: WatchRecord,
    kind: RunKind,
    scheduledFor: string,
    nextRunAt: string | null,
    options: { throwOnError?: boolean; idempotencyKey?: string } = {},
  ): Job | null {
    const now = this.clock.iso();
    const request: WatchJobRequest = {
      type: 'watch',
      watchId: watch.id,
      label: `Watch: ${watch.name}`,
      domains: watch.domains,
      includeRegistry: watch.includeRegistry,
      providerIds: watch.providerIds,
      includeCatalogPrices: watch.includeCatalogPrices,
    };
    const missedRuns = kind === 'catch_up' ? watch.missedRuns : 0;
    const note =
      kind === 'catch_up'
        ? `Catch-up run after ${watch.missedRuns} missed ${watch.missedRuns === 1 ? 'check' : 'checks'}.`
        : kind === 'manual'
          ? 'Started manually.'
          : null;
    const record = (job: Job | null, failure: string | null) => {
      // A job that finished synchronously may already have a run row from onJobFinished; it still
      // gets the idempotency key so a replay returns this job instead of starting another.
      const existing = job ? this.db.get<{ id: string }>('SELECT id FROM watch_runs WHERE job_id = ? LIMIT 1', [job.id]) : undefined;
      if (existing && options.idempotencyKey) {
        this.db.run('UPDATE watch_runs SET idempotency_key = COALESCE(idempotency_key, ?) WHERE id = ?', [options.idempotencyKey, existing.id]);
      }
      if (!existing) {
        this.db.run(
          `INSERT INTO watch_runs (id, watch_id, status, scheduled_for, started_at, finished_at, job_id, changes, failures, note, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
          [
            randomUUID(),
            watch.id,
            job ? (kind === 'catch_up' ? 'catch_up' : 'running') : 'cancelled',
            scheduledFor,
            now,
            job ? null : now,
            job?.id ?? null,
            job ? note : joinNotes(note, `Could not start: ${failure}`),
            options.idempotencyKey ?? null,
          ],
        );
      }
      this.db.run(
        `UPDATE watches SET last_run_at = ?, next_run_at = ?, last_job_id = COALESCE(?, last_job_id), missed_runs = ? WHERE id = ?`,
        [now, watch.state === 'active' ? nextRunAt : null, job?.id ?? null, missedRuns, watch.id],
      );
      this.watches.changed(watch.id, job?.id ?? null);
    };

    let failure: string;
    if (this.submitter) {
      const submitter = this.submitter;
      try {
        // Submission and run bookkeeping commit together, so a job is never left untracked.
        return this.db.transaction(() => {
          const job = submitter.submit(
            request,
            options.idempotencyKey
              ? { watchId: watch.id, idempotencyKey: options.idempotencyKey, operationId: 'runWatch' }
              : { watchId: watch.id },
          );
          record(job, null);
          return job;
        });
      } catch (error) {
        if (options.throwOnError) throw error;
        failure = error instanceof Error ? error.message : String(error);
      }
    } else {
      if (options.throwOnError) throw new AppError('unavailable', 'The job engine is not available');
      failure = 'The job engine is not available';
    }
    this.logger.warn(`Watch ${watch.id} could not start: ${failure}`);
    this.db.transaction(() => record(null, failure));
    return null;
  }

  /** True while a run row is open; call reconcileActiveRuns() first so finished jobs are closed. */
  private hasActiveRun(watchId: string): boolean {
    return this.db.get(`SELECT 1 FROM watch_runs WHERE watch_id = ? AND ${ACTIVE_RUN} LIMIT 1`, [watchId]) !== undefined;
  }

  /**
   * Close runs whose job already finished (in case a completion notification was missed), whose
   * job was deleted (job_id set to NULL by the foreign key) or no longer exists.
   */
  private reconcileActiveRuns() {
    const runs = this.db.all<RunRow>(`SELECT * FROM watch_runs WHERE ${ACTIVE_RUN}`);
    for (const run of runs) {
      let job: Job | null = null;
      if (run.job_id) {
        if (!this.submitter) continue;
        try {
          job = this.submitter.get(run.job_id);
        } catch {
          job = null;
        }
      }
      if (job && TERMINAL_JOB_STATES.includes(job.state)) {
        this.onJobFinished(job);
      } else if (!job) {
        this.db.transaction(() => {
          this.db.run(`UPDATE watch_runs SET status = 'cancelled', finished_at = ?, note = ? WHERE id = ?`, [
            this.clock.iso(),
            joinNotes(run.note, 'The job for this run was deleted.'),
            run.id,
          ]);
          if (this.watches.find(run.watch_id)) this.watches.changed(run.watch_id);
        });
      }
    }
  }

  private safely(fn: () => void) {
    try {
      fn();
    } catch (error) {
      this.logger.error(`Monitoring step failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** First slot on the watch's cadence strictly after `now`. */
export function nextSlotAfter(scheduledFor: string, intervalMinutes: number, now: string): string {
  const intervalMs = intervalMinutes * MINUTE_MS;
  const start = Date.parse(scheduledFor);
  const elapsed = Date.parse(now) - start;
  const steps = elapsed < 0 ? 1 : Math.floor(elapsed / intervalMs) + 1;
  return new Date(start + steps * intervalMs).toISOString();
}

function joinNotes(a: string | null, b: string | null): string | null {
  const parts = [a, b].filter((p): p is string => !!p);
  return parts.length ? parts.join(' ') : null;
}
