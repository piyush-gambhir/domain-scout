import type { Migration } from '../storage/migrations.js';

/**
 * Providers and pricing schema additions (versions 40-49 are reserved for these modules).
 * Secrets never live in SQLite: the providers table only records credential test and failure state.
 */
export const PROVIDERS_MIGRATION: Migration = {
  version: 40,
  name: 'providers_credential_state',
  sql: /* sql */ `
-- Set when an operation or test got an authentication failure; cleared by a successful test or new credentials.
ALTER TABLE providers ADD COLUMN credential_status TEXT CHECK (credential_status IN ('invalid'));
ALTER TABLE providers ADD COLUMN credential_status_message TEXT;
ALTER TABLE providers ADD COLUMN credential_status_at TEXT;
ALTER TABLE providers ADD COLUMN last_test_operation TEXT;

CREATE INDEX offers_catalog_fetch ON offers(catalog_fetch_id);
CREATE INDEX offers_domain_provider ON offers(domain, provider_id, purchase_path, observed_at DESC);
CREATE INDEX catalog_fetches_status ON catalog_fetches(provider_id, status, fetched_at DESC);
`,
};
