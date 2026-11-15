
export interface JobsEngineOptions {

  batchSize: number;

  maxBuffered: number;

  backoffBaseMs: number;
  backoffMaxMs: number;

  progressIntervalMs: number;

  sweepBatchSize: number;

  maxItemsPerJob: number;
}

export const JOBS_ENGINE_OPTIONS = Symbol('JOBS_ENGINE_OPTIONS');

export const DEFAULT_ENGINE_OPTIONS: JobsEngineOptions = {
  batchSize: 64,
  maxBuffered: 512,
  backoffBaseMs: 1000,
  backoffMaxMs: 30_000,
  progressIntervalMs: 250,
  sweepBatchSize: 200,
  maxItemsPerJob: 200_000,
};
