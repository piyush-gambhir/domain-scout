import type { Migration } from '../storage/migrations.js';








export const JOBS_MIGRATION: Migration = {
  version: 20,
  name: 'jobs_source_keys',
  sql:           `
ALTER TABLE job_items ADD COLUMN source_key TEXT NOT NULL DEFAULT '';
CREATE INDEX job_items_job_source ON job_items(job_id, source_key, state, seq);
`,
};





export const JOBS_ORIGIN_MIGRATION: Migration = {
  version: 21,
  name: 'jobs_origin',
  sql:           `
ALTER TABLE jobs ADD COLUMN origin TEXT NOT NULL DEFAULT 'api';
UPDATE jobs SET origin = 'watch' WHERE type = 'watch' OR watch_id IS NOT NULL;
UPDATE jobs SET origin = 'system' WHERE type = 'catalog_refresh';
CREATE INDEX jobs_origin ON jobs(origin, created_at DESC);
`,
};
