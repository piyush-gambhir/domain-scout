import type { JobOperation, JobType, Settings } from '@domain-scout/contracts';
import type { ObservationWrite, OfferWrite } from '../storage/evidence.js';

/**
 * Contract between the jobs engine and the modules that do external work.
 *
 * The engine owns scheduling, source budgets, cooldowns, retries, cancellation, persistence and
 * events. A handler performs one item and returns evidence; the engine writes that evidence, the
 * item state, counters and events in one transaction.
 */
export interface JobItemRecord {
  id: string;
  jobId: string;
  jobType: JobType;
  seq: number;
  /** ASCII domain, a name for name checks, or a provider id for catalog refreshes. */
  subject: string;
  unicode: string;
  suffix: string | null;
  operation: JobOperation;
  /** Provider id, name-check service, diagnostic check or aftermarket source; '' when not applicable. */
  target: string;
  attempts: number;
  /** Parsed jobs.input_json (the validated request plus planner extras such as `recheck`). */
  jobInput: Record<string, unknown>;
}

export interface OperationContext {
  signal: AbortSignal;
  /** 1-based attempt number for this execution. */
  attempt: number;
  settings: Settings;
  now(): Date;
  /** False when the job asked for fresh checks; true lets handlers reuse fresh cached evidence. */
  allowCache: boolean;
}

export type EvidenceWrite = { kind: 'observation'; row: ObservationWrite } | { kind: 'offer'; row: OfferWrite };

export interface OperationResult {
  /** Operation-specific outcome, e.g. a RegistryOutcome or ConfirmationStatus. */
  outcome: string;
  /** True when the outcome is a definitive answer (see RESOLVED_ITEM_OUTCOMES). */
  resolved: boolean;
  /** Evidence to persist atomically with the item update. */
  evidence: EvidenceWrite[];
  /** Fresh evidence reused instead of querying again. */
  reused?: { registryObservationId?: string; observationIds?: string[] };
  error?: { code: string; message: string; retryable: boolean } | null;
  /** Transient failure eligible for automatic retry with backoff (network error, 5xx, timeout). */
  retryable?: boolean;
  /** The source asked us to wait (Retry-After or a block); applied as a shared cooldown on the source key. */
  cooldownUntil?: string | null;
  /** When an unresolved item may be retried. */
  retryAt?: string | null;
}

export interface OperationHandler {
  readonly operation: JobOperation;
  /**
   * Budget key shared by every job and watch, e.g. `registry:verisign`, `provider:porkbun`,
   * `service:github`, `resolver:cloudflare`. RDAP and WHOIS for one registry share a key.
   * Null means local work with no external source.
   */
  sourceKey(item: JobItemRecord): string | null;
  /** Destination the subject is disclosed to (host or URL), for job.destinations and audits. */
  destination(item: JobItemRecord): string | null;
  execute(item: JobItemRecord, ctx: OperationContext): Promise<OperationResult>;
  /** Optional per-item time limit in ms; defaults to settings.retries.timeoutMs (e.g. large catalogs need longer). */
  timeoutMs?(item: JobItemRecord, settings: Settings): number | undefined;
}
