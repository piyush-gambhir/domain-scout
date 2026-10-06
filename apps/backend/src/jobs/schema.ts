import type { Migration } from '../storage/migrations.js';

/**
 * Jobs engine schema additions (versions 20-29 are reserved for jobs).
 *
 * `source_key` is the handler's budget key computed at planning time. The scheduler loads pending
 * items per job and source in small batches, so one busy or cooling source never blocks the others
 * and memory stays bounded for very large jobs. '' means local work with no external source.
 */
export const JOBS_MIGRATION: Migration = {
  version: 20,
  name: 'jobs_source_keys',
  sql: /* sql */ `
ALTER TABLE job_items ADD COLUMN source_key TEXT NOT NULL DEFAULT '';
CREATE INDEX job_items_job_source ON job_items(job_id, source_key, state, seq);
`,
};

/**
 * Who started each job, so History can show UI and agent (CLI) runs and hide system work. Existing
 * rows are classified from what they are: watch runs, catalog refreshes, else an API client.
 */
export const JOBS_ORIGIN_MIGRATION: Migration = {
  version: 21,
  name: 'jobs_origin',
  sql: /* sql */ `
ALTER TABLE jobs ADD COLUMN origin TEXT NOT NULL DEFAULT 'api';
UPDATE jobs SET origin = 'watch' WHERE type = 'watch' OR watch_id IS NOT NULL;
UPDATE jobs SET origin = 'system' WHERE type = 'catalog_refresh';
CREATE INDEX jobs_origin ON jobs(origin, created_at DESC);
`,
};
