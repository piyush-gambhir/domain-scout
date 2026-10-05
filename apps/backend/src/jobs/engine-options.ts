/** Engine internals that are not user settings. Tests override the provider to shorten waits. */
export interface JobsEngineOptions {
  /** Pending items loaded per job and source at a time; bounds memory for large jobs. */
  batchSize: number;
  /** Upper bound on buffered pending items per job and source. */
  maxBuffered: number;
  /** First automatic retry waits about this long; later attempts double it (with jitter). */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Minimum real time between transient job.progress events for one job. */
  progressIntervalMs: number;
  /** Items finished per transaction when a long source cooldown settles pending work. */
  sweepBatchSize: number;
  /** Upper bound on items in one job so a single submission cannot exhaust memory or block SQLite. */
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
