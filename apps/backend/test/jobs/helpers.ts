import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RESOLVED_ITEM_OUTCOMES,
  TERMINAL_JOB_STATES,
  type DomainEvent,
  type InputPreview,
  type InputPreviewRow,
  type InputSourceParsed,
  type Job,
  type JobOperation,
  type NormalizedDomain,
  type SettingsPatch,
} from '@domain-scout/contracts';
import type { z } from 'zod';
import { FakeClock, type Clock } from '../../src/core/clock.js';
import type { InputPreviewer, ProviderDirectory } from '../../src/core/ports.js';
import { EventsService } from '../../src/events/events.service.js';
import { DEFAULT_ENGINE_OPTIONS, JOBS_ENGINE_OPTIONS, type JobsEngineOptions } from '../../src/jobs/engine-options.js';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { OperationRegistry } from '../../src/jobs/operation-registry.js';
import type { JobItemRecord, OperationContext, OperationHandler, OperationResult } from '../../src/jobs/operation.js';
import { OptionalPorts } from '../../src/jobs/optional-ports.js';
import { JobResultsService } from '../../src/jobs/results.service.js';
import { Database } from '../../src/storage/database.js';
import { SettingsService } from '../../src/system/settings.service.js';
import { createTestApp, type TestApp } from '../helpers.js';

/** Fake time that moves with real time (so timers fire) and can also be advanced by tests. */
export class LiveClock extends FakeClock {
  private offset = 0;
  override now() {
    return new Date(Date.now() + this.offset);
  }
  override advance(ms: number) {
    this.offset += ms;
  }
  override set(date: Date | string) {
    this.offset = new Date(date).getTime() - Date.now();
  }
}

/** Registry for jobs tests: production modules' handlers are ignored so only the fakes run. */
export class TestOperationRegistry extends OperationRegistry {
  private readonly fakes = new Map<JobOperation, OperationHandler>();
  override register(_handler: OperationHandler) {}
  use(...handlers: OperationHandler[]) {
    for (const handler of handlers) this.fakes.set(handler.operation, handler);
  }
  override get(operation: JobOperation) {
    return this.fakes.get(operation);
  }
  override operations() {
    return [...this.fakes.keys()];
  }
}

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function normalizeDomain(domain: string): NormalizedDomain | null {
  if (!DOMAIN.test(domain) || domain.endsWith('.invalid')) return null;
  const [label, ...rest] = domain.split('.');
  return { ascii: domain, unicode: domain, label: label!, suffix: rest.join('.'), isIdn: false };
}

/** Minimal InputPreviewer: lines, commas or whitespace; base names expand across extensions. */
export function fakePreviewer(): InputPreviewer {
  return {
    normalize: normalizeDomain,
    preview(source: InputSourceParsed): InputPreview {
      const tokens = [...(source.text ?? '').split(/[\s,]+/), ...(source.domains ?? [])].map((t) => t.trim()).filter(Boolean);
      const rows: InputPreviewRow[] = [];
      const domains: string[] = [];
      const seen = new Set<string>();
      tokens.forEach((token, index) => {
        const lower = token.toLowerCase();
        const expanded = lower.includes('.') ? [lower] : source.extensions.map((e) => `${lower}.${e}`);
        for (const candidate of expanded) {
          const base = { row: index + 1, original: token, suggestion: null, expandedFrom: lower.includes('.') ? null : lower };
          const domain = normalizeDomain(candidate);
          if (!domain) {
            rows.push({ ...base, status: 'invalid', domain: null, reasons: [{ code: 'invalid_characters', message: 'invalid' }], duplicateOf: null });
          } else if (seen.has(candidate)) {
            rows.push({ ...base, status: 'duplicate', domain, reasons: [{ code: 'duplicate', message: 'duplicate' }], duplicateOf: candidate });
          } else {
            seen.add(candidate);
            domains.push(candidate);
            rows.push({ ...base, status: 'valid', domain, reasons: [], duplicateOf: null });
          }
        }
      });
      const count = (status: string) => rows.filter((r) => r.status === status).length;
      return {
        rows,
        domains,
        extensions: source.extensions,
        counts: {
          inputRows: tokens.length,
          valid: count('valid'),
          duplicate: count('duplicate'),
          invalid: count('invalid'),
          ambiguous: 0,
          uniqueDomains: domains.length,
          totalChecks: domains.length,
        },
      };
    },
  } as InputPreviewer;
}

export function fakeDirectory(ids: string[]): ProviderDirectory {
  return { exists: (id: string) => ids.includes(id), summary: () => [], forDomain: () => [] } as unknown as ProviderDirectory;
}

export interface FakeCall {
  item: JobItemRecord;
  attempt: number;
  at: number;
  allowCache: boolean;
}

export type FakeHandler = OperationHandler & { calls: FakeCall[] };

export function fakeHandler(options: {
  operation: JobOperation;
  sourceKey?: (item: JobItemRecord) => string | null;
  destination?: (item: JobItemRecord) => string | null;
  execute?: (item: JobItemRecord, ctx: OperationContext) => Promise<OperationResult> | OperationResult;
}): FakeHandler {
  const calls: FakeCall[] = [];
  return {
    operation: options.operation,
    calls,
    sourceKey: options.sourceKey ?? (() => null),
    destination: options.destination ?? (() => null),
    async execute(item, ctx) {
      calls.push({ item, attempt: ctx.attempt, at: ctx.now().getTime(), allowCache: ctx.allowCache });
      return options.execute ? options.execute(item, ctx) : simpleResult(item, ctx);
    },
  };
}

/** A resolved result with evidence of the right kind for the operation. */
export function simpleResult(item: JobItemRecord, ctx: OperationContext, outcome?: string): OperationResult {
  if (item.operation === 'registry') return registryResult(item, ctx, outcome ?? 'no_record');
  const out = outcome ?? RESOLVED_ITEM_OUTCOMES[item.operation][0]!;
  return { outcome: out, resolved: RESOLVED_ITEM_OUTCOMES[item.operation].includes(out), evidence: [] };
}

export function registryResult(
  item: JobItemRecord,
  ctx: OperationContext,
  outcome = 'no_record',
  extra: Partial<OperationResult> = {},
): OperationResult {
  const id = randomUUID();
  const checkedAt = ctx.now().toISOString();
  const staleAt = new Date(ctx.now().getTime() + 15 * 60_000).toISOString();
  const source = { registryId: 'test', protocol: 'rdap', destination: 'https://rdap.test/', routing: 'curated' };
  return {
    outcome,
    resolved: RESOLVED_ITEM_OUTCOMES.registry.includes(outcome),
    evidence: [
      {
        kind: 'observation',
        row: {
          id,
          kind: 'registry',
          subject: item.subject,
          suffix: item.suffix,
          sourceId: 'registry:test',
          destination: source.destination,
          outcome,
          observedAt: checkedAt,
          staleAt,
          payload: {
            id,
            domain: item.subject,
            unicode: item.unicode,
            suffix: item.suffix,
            source,
            outcome,
            eligibility: { status: 'unknown', source: null, scope: null },
            reason: { code: outcome, message: `Test ${outcome}` },
            checkedAt,
            staleAt,
            httpStatus: outcome === 'no_record' ? 404 : 200,
            retryAt: null,
            matchedName: outcome === 'registered' ? item.subject : null,
            parserVersion: 'test-1',
            registration: null,
            hasRawDiagnostics: false,
          },
        },
      },
    ],
    ...extra,
  };
}

/** A manually released barrier for holding handler calls in flight. */
export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 10_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const TEST_SETTINGS: z.output<typeof SettingsPatch> = {
  concurrency: { global: 16, perSource: 1, minSourceIntervalMs: 0, maxCooldownWaitSeconds: 300 },
  retries: { maxAttempts: 3, timeoutMs: 5000 },
};

export interface JobsTestApp extends TestApp {
  dataDir: string;
  registry: TestOperationRegistry;
  jobs: JobsService;
  results: JobResultsService;
  events: EventsService;
  db: Database;
  settings: SettingsService;
  /** Waits until the job reaches a terminal state and returns it. */
  finished(jobId: string, timeoutMs?: number): Promise<Job>;
  /** Persisted events for a job, in order. */
  jobEvents(jobId: string): DomainEvent[];
}

export async function createJobsApp(
  options: {
    dataDir?: string;
    clock?: Clock;
    previewer?: InputPreviewer | null;
    directory?: ProviderDirectory | null;
    engine?: Partial<JobsEngineOptions>;
    settings?: z.output<typeof SettingsPatch>;
    stopGraceMs?: number;
    /** Keep the data directory after close (restart tests reopen it). */
    keepData?: boolean;
  } = {},
): Promise<JobsTestApp> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'domain-scout-jobs-'));
  const registry = new TestOperationRegistry();
  const previewer = options.previewer === undefined ? fakePreviewer() : options.previewer;
  const directory = options.directory === undefined ? fakeDirectory(['porkbun', 'namecheap', 'hostinger']) : options.directory;
  const ports = { previewer: () => previewer, providers: () => directory } as unknown as OptionalPorts;
  const t = await createTestApp({
    clock: options.clock ?? new LiveClock(),
    config: { dataDir, runtimeDir: join(dataDir, 'run'), stopGraceMs: options.stopGraceMs ?? 100 },
    overrides: [
      { provide: OperationRegistry, useValue: registry },
      { provide: OptionalPorts, useValue: ports },
      { provide: JOBS_ENGINE_OPTIONS, useValue: { ...DEFAULT_ENGINE_OPTIONS, backoffBaseMs: 20, ...options.engine } },
    ],
  });
  const settings = t.app.get(SettingsService);
  settings.patch(options.settings ?? TEST_SETTINGS);
  const jobs = t.app.get(JobsService);
  const events = t.app.get(EventsService);
  return {
    ...t,
    dataDir,
    registry,
    jobs,
    results: t.app.get(JobResultsService),
    events,
    db: t.app.get(Database),
    settings,
    finished: (jobId, timeoutMs = 10_000) =>
      waitFor(
        () => {
          const job = jobs.get(jobId);
          return TERMINAL_JOB_STATES.includes(job.state) ? job : null;
        },
        timeoutMs,
        `job ${jobId} to finish`,
      ),
    jobEvents: (jobId) => events.read(0, { jobId }, 100_000),
    async close() {
      await t.close();
      if (!options.keepData) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function domains(count: number, suffixes = ['com']): string[] {
  return Array.from({ length: count }, (_, n) => `name${String(n).padStart(5, '0')}.${suffixes[n % suffixes.length]}`);
}
