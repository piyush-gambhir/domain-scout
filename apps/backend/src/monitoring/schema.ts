import type { Migration } from '../storage/migrations.js';







export const MONITORING_MIGRATION: Migration = {
  version: 50,
  name: 'watch_run_idempotency',
  sql:           `
ALTER TABLE watch_runs ADD COLUMN idempotency_key TEXT;
CREATE INDEX watch_runs_idempotency ON watch_runs(watch_id, idempotency_key);
CREATE INDEX watch_runs_job ON watch_runs(job_id);
`,
};
