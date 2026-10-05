import {
  Injectable,
  Logger,
  Optional,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  InputSource,
  TERMINAL_JOB_STATES,
  type Job,
  type JobListQuery,
  type JobOperation,
  type RecheckRequest,
  type RetryRequest,
} from '@domain-scout/contracts';
import type { z } from 'zod';
import { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { JobLifecycle, JobSubmitter, type SubmitOptions } from '../core/ports.js';
import { EventsService } from '../events/events.service.js';
import { ShutdownCoordinator } from '../runtime/shutdown.js';
import { Database } from '../storage/database.js';
import { SettingsService } from '../system/settings.service.js';
import { requestFingerprint } from './idempotency.js';
import { JobStore, type ItemRow } from './job-store.js';
import { JobLifecycleHub } from './lifecycle.js';
import type { JobItemRecord, OperationHandler } from './operation.js';
import { OperationRegistry } from './operation-registry.js';
import { JobPlanner, type JobPlan, type SubmitRequest } from './planner.js';
import { JobScheduler } from './scheduler.js';

type RetryBody = z.output<typeof RetryRequest>;
type RecheckBody = z.output<typeof RecheckRequest>;
type ListQuery = z.output<typeof JobListQuery>;

interface IdempotencyClaim {
  key: string;
  operation: string;
  fingerprint: string;
}

/**
 * Job submission and control: planning, idempotency, persistence, cancel/resume/retry/recheck and
 * deletion. Implements the JobSubmitter and JobLifecycle ports for other modules.
 */
@Injectable()
export class JobsService implements JobSubmitter, JobLifecycle, OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private recovered: Job[] = [];

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly events: EventsService,
    private readonly settings: SettingsService,
    private readonly registry: OperationRegistry,
    private readonly store: JobStore,
    private readonly planner: JobPlanner,
    private readonly scheduler: JobScheduler,
    private readonly lifecycle: JobLifecycleHub,
    @Optional() private readonly shutdown?: ShutdownCoordinator,
  ) {}

  onModuleInit() {
    this.scheduler.loadCooldowns();
    this.recovered = this.scheduler.recover();
    // Halts dispatch; in-flight calls are aborted at the grace deadline and recorded as interrupted.
    this.shutdown?.onStopping((ctx) => this.scheduler.stop(ctx.signal), 'jobs');
    // Budgets are read on every pass; a changed limit takes effect without waiting for a completion.
    this.settings.onChange(() => this.scheduler.wake());
  }

  /** Listeners registered during module init hear about jobs recovered as interrupted. */
  onApplicationBootstrap() {
    for (const job of this.recovered) this.lifecycle.notify(job);
    this.recovered = [];
  }

  /** Fallback when no ShutdownCoordinator ran the stop hook: abort at once and record interruptions. */
  async beforeApplicationShutdown() {
    await this.scheduler.stop();
  }

  submit(request: SubmitRequest, options: SubmitOptions = {}): Job {
    const operationId = options.operationId ?? `submit:${request.type}`;
    const payload = { request, watchId: options.watchId ?? null, parentJobId: options.parentJobId ?? null };
    return this.idempotent(options.idempotencyKey, operationId, payload, (claim) => {
      const plan = this.planner.plan(request);
      return this.create({ ...plan, watchId: plan.watchId ?? options.watchId ?? null }, options.parentJobId ?? null, claim);
    });
  }

  get(jobId: string): Job {
    return this.store.job(jobId, { includeText: true });
  }

  list(query: ListQuery) {
    return this.store.list(query);
  }

  onFinished(listener: (job: Job) => void): () => void {
    return this.lifecycle.onFinished(listener);
  }

  cancel(jobId: string): Job {
    this.outsideTransaction('cancel');
    return this.scheduler.cancel(jobId);
  }

  resume(jobId: string): Job {
    this.outsideTransaction('resume');
    return this.scheduler.resume(jobId);
  }

  /** Cancel and resume change in-memory scheduling, which an outer rollback could not undo. */
  private outsideTransaction(action: string) {
    if (this.db.inTransaction) throw new Error(`JobsService.${action} must not run inside another transaction`);
  }

  /** New job for the selected items with the same operations and targets; the parent is untouched. */
  retry(jobId: string, body: RetryBody, options: SubmitOptions = {}): Job {
    const operationId = options.operationId ?? 'retryJob';
    return this.idempotent(options.idempotencyKey, operationId, { jobId, body }, (claim) => {
      const parent = this.store.requireJobRow(jobId);
      const rows = this.retryItems(jobId, body);
      if (rows.length === 0) throw AppError.invalid('No items of this job match the retry selection');
      const input = this.store.input(parent);
      const plan: JobPlan = {
        type: parent.type,
        label: parent.label,
        watchId: null,
        input: { ...input, summary: { ...input.summary, rows: new Set(rows.map((r) => r.subject)).size } },
        items: rows.map((r) => ({ subject: r.subject, unicode: r.unicode, suffix: r.suffix, operation: r.operation, target: r.target })),
      };
      return this.create(plan, jobId, claim);
    });
  }

  /** Fresh registry checks for explicit domains: a registry scan that ignores cached evidence. */
  recheck(body: RecheckBody, options: SubmitOptions = {}): Job {
    return this.submit(
      { type: 'registry_scan', label: body.label, input: InputSource.parse({ domains: body.domains }), recheck: true },
      { ...options, operationId: options.operationId ?? 'createRecheck' },
    );
  }

  /** Deletes a finished job and its items and events. Evidence rows stay for shortlists and history. */
  remove(jobId: string) {
    const row = this.store.requireJobRow(jobId);
    if (!TERMINAL_JOB_STATES.includes(row.state) || this.scheduler.has(jobId)) {
      throw AppError.conflict(`Only finished jobs can be deleted; this job is ${row.state}`);
    }
    this.db.transaction(() => {
      this.events.deleteFor({ jobIds: [jobId] });
      this.db.run('DELETE FROM jobs WHERE id = ?', [jobId]);
    });
  }

  private retryItems(jobId: string, body: RetryBody): ItemRow[] {
    const where = ['job_id = ?'];
    const params: string[] = [jobId];
    if (body.itemIds?.length) {
      where.push('id IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(body.itemIds));
    }
    if (body.outcomes?.length) {
      where.push(`state = 'finished' AND outcome IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(body.outcomes));
    }
    if (!body.itemIds?.length && !body.outcomes?.length && body.unresolvedOnly) {
      where.push(`state = 'finished' AND resolved = 0`);
    }
    return this.db.all<ItemRow>(`SELECT * FROM job_items WHERE ${where.join(' AND ')} ORDER BY seq`, params);
  }

  /**
   * Same key and fingerprint returns the original job; a different request under the same key is a
   * conflict. The claim is stored in the transaction that creates the job.
   */
  private idempotent(key: string | undefined, operation: string, payload: unknown, create: (claim: IdempotencyClaim | null) => Job): Job {
    if (!key) return create(null);
    const fingerprint = requestFingerprint(operation, payload);
    const existing = this.db.get<{ fingerprint: string; job_id: string | null }>(
      'SELECT fingerprint, job_id FROM idempotency_requests WHERE key = ?',
      [key],
    );
    if (existing) {
      if (existing.fingerprint !== fingerprint || !existing.job_id) {
        throw new AppError('idempotency_conflict', 'This Idempotency-Key was already used for a different request');
      }
      return this.store.job(existing.job_id, { includeText: true });
    }
    return create({ key, operation, fingerprint });
  }

  private create(plan: JobPlan, parentJobId: string | null, claim: IdempotencyClaim | null): Job {
    if (this.scheduler.isStopping) throw new AppError('unavailable', 'The backend is stopping', { retryable: true });
    const handlers = new Map<JobOperation, OperationHandler>();
    for (const item of plan.items) {
      if (handlers.has(item.operation)) continue;
      const handler = this.registry.get(item.operation);
      if (!handler) {
        throw new AppError('unavailable', `No handler is registered for the ${item.operation} operation`, { retryable: true });
      }
      handlers.set(item.operation, handler);
    }
    const jobId = randomUUID();
    const now = this.clock.iso();
    const destinations = new Set<string>();
    const items = plan.items.map((item, seq) => {
      const record: JobItemRecord = {
        id: randomUUID(),
        jobId,
        jobType: plan.type,
        seq,
        subject: item.subject,
        unicode: item.unicode,
        suffix: item.suffix,
        operation: item.operation,
        target: item.target,
        attempts: 0,
        jobInput: plan.input,
      };
      const handler = handlers.get(item.operation)!;
      const destination = handler.destination(record);
      if (destination) destinations.add(destination);
      return { record, sourceKey: handler.sourceKey(record) ?? '' };
    });
    const settings = this.settings.get();
    this.db.transaction(() => {
      this.store.insertJob({
        id: jobId,
        type: plan.type,
        label: plan.label,
        input: plan.input,
        destinations: [...destinations],
        policy: { operations: [...handlers.keys()], concurrency: settings.concurrency, retries: settings.retries },
        watchId: plan.watchId,
        parentJobId,
        total: items.length,
        now,
      });
      for (const { record, sourceKey } of items) {
        this.store.insertItem({
          id: record.id,
          jobId,
          seq: record.seq,
          subject: record.subject,
          unicode: record.unicode,
          suffix: record.suffix,
          operation: record.operation,
          target: record.target,
          sourceKey,
          now,
        });
      }
      if (claim) {
        this.db.run('INSERT INTO idempotency_requests (key, operation, fingerprint, job_id, created_at) VALUES (?, ?, ?, ?, ?)', [
          claim.key,
          claim.operation,
          claim.fingerprint,
          jobId,
          now,
        ]);
      }
      this.events.emit('job.updated', { jobId, watchId: plan.watchId }, this.store.job(jobId));
    });
    const job = this.store.job(jobId, { includeText: true });
    if (this.db.inTransaction) {
      // Submitted inside a caller's transaction (e.g. with watch-run bookkeeping): start only once that
      // transaction has settled, and only if the job was committed.
      queueMicrotask(() => this.admit(jobId));
    } else {
      this.scheduler.add(jobId);
    }
    return job;
  }

  private admit(jobId: string) {
    try {
      const row = this.store.jobRow(jobId);
      if (row?.state === 'queued' && !this.scheduler.has(jobId) && !this.scheduler.isStopping) this.scheduler.add(jobId);
    } catch (error) {
      // Left queued; startup recovery marks it interrupted so it can be resumed.
      this.logger.error(`Could not start job ${jobId}: ${(error as Error).message}`);
    }
  }
}
