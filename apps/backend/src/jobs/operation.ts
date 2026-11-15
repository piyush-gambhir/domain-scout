import type { JobOperation, JobType, Settings } from '@domain-scout/contracts';
import type { ObservationWrite, OfferWrite } from '../storage/evidence.js';








export interface JobItemRecord {
  id: string;
  jobId: string;
  jobType: JobType;
  seq: number;

  subject: string;
  unicode: string;
  suffix: string | null;
  operation: JobOperation;

  target: string;
  attempts: number;

  jobInput: Record<string, unknown>;
}

export interface OperationContext {
  signal: AbortSignal;

  attempt: number;
  settings: Settings;
  now(): Date;

  allowCache: boolean;
}

export type EvidenceWrite = { kind: 'observation'; row: ObservationWrite } | { kind: 'offer'; row: OfferWrite };

export interface OperationResult {

  outcome: string;

  resolved: boolean;

  evidence: EvidenceWrite[];




  reused?: { registryObservationId?: string; observationIds?: string[]; offerIds?: string[] };
  error?: { code: string; message: string; retryable: boolean } | null;

  retryable?: boolean;

  cooldownUntil?: string | null;

  retryAt?: string | null;
}

export interface OperationHandler {
  readonly operation: JobOperation;





  sourceKey(item: JobItemRecord): string | null;

  destination(item: JobItemRecord): string | null;
  execute(item: JobItemRecord, ctx: OperationContext): Promise<OperationResult>;

  timeoutMs?(item: JobItemRecord, settings: Settings): number | undefined;
}
