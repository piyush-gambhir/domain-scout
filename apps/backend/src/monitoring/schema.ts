import type { Migration } from '../storage/migrations.js';

/**
 * Monitoring schema additions (versions 50-59 are reserved for collections, monitoring and artifacts).
 *
 * `idempotency_key` lets a retried POST /watches/:id/run return the original job, even while that
 * run is still in progress, instead of reporting a conflict.
 */
export const MONITORING_MIGRATION: Migration = {
  version: 50,
  name: 'watch_run_idempotency',
  sql: /* sql */ `
ALTER TABLE watch_runs ADD COLUMN idempotency_key TEXT;
CREATE INDEX watch_runs_idempotency ON watch_runs(watch_id, idempotency_key);
CREATE INDEX watch_runs_job ON watch_runs(job_id);
`,
};
