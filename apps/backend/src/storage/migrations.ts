/**
 * Versioned migrations, embedded so the compiled backend needs no SQL asset files.
 * Never edit an applied migration; add a new version instead.
 *
 * Conventions: TEXT ids (UUID), UTC ISO timestamps as TEXT, money as decimal TEXT, JSON as TEXT.
 * Evidence tables are append-only; current views are derived by querying the latest row.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const INITIAL = /* sql */ `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE bootstrap_codes (
  code_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Registry routing: one row per registration suffix that we know a destination or status for.
CREATE TABLE suffix_rules (
  suffix TEXT PRIMARY KEY,
  tld TEXT NOT NULL,
  registry_id TEXT,
  protocol TEXT CHECK (protocol IN ('rdap', 'whois')),
  endpoint TEXT,
  routing TEXT CHECK (routing IN ('iana_bootstrap', 'curated')),
  routing_updated_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('tested', 'discovered', 'unsupported')),
  parser TEXT,
  notes_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX suffix_rules_status ON suffix_rules(status);

CREATE TABLE source_cooldowns (
  source_key TEXT PRIMARY KEY,
  until TEXT NOT NULL,
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Immutable sourced evidence of every kind. payload_json holds the contract object.
CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('registry', 'confirmation', 'name_check', 'diagnostic', 'listing')),
  subject TEXT NOT NULL,
  suffix TEXT,
  source_id TEXT,
  destination TEXT,
  outcome TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  stale_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX observations_subject ON observations(kind, subject, observed_at DESC);
CREATE INDEX observations_source ON observations(source_id, observed_at DESC);
CREATE INDEX observations_time ON observations(observed_at);

CREATE TABLE raw_diagnostics (
  observation_id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  content_type TEXT,
  body TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Provider preferences and credential test state. Secrets never live in SQLite.
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  preferred INTEGER NOT NULL DEFAULT 0,
  last_tested_at TEXT,
  last_test_result TEXT,
  last_test_message TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE catalog_fetches (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  fetched_at TEXT NOT NULL,
  suffix_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  error_json TEXT
);
CREATE INDEX catalog_fetches_provider ON catalog_fetches(provider_id, fetched_at DESC);

CREATE TABLE provider_suffixes (
  provider_id TEXT NOT NULL,
  suffix TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, suffix)
);
CREATE INDEX provider_suffixes_suffix ON provider_suffixes(suffix);

-- Append-only prices: catalog rows (domain NULL) and exact-name quotes.
CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  domain TEXT,
  suffix TEXT NOT NULL,
  purchase_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('published', 'estimated', 'exact_quote')),
  currency TEXT NOT NULL,
  region TEXT,
  term_years INTEGER NOT NULL DEFAULT 1,
  promotional INTEGER NOT NULL DEFAULT 0,
  registration TEXT,
  renewal TEXT,
  transfer TEXT,
  observed_at TEXT NOT NULL,
  stale_at TEXT NOT NULL,
  quote_expires_at TEXT,
  catalog_fetch_id TEXT REFERENCES catalog_fetches(id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX offers_scope ON offers(provider_id, suffix, purchase_path, observed_at DESC);
CREATE INDEX offers_domain ON offers(domain, observed_at DESC);
CREATE INDEX offers_suffix ON offers(suffix, kind, observed_at DESC);

-- Derived: lowest published first-year registration per suffix and currency among enabled
-- providers. Recomputed by pricing on catalog refresh and provider preference changes.
CREATE TABLE best_prices (
  suffix TEXT NOT NULL,
  currency TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  years INTEGER NOT NULL,
  kind TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (suffix, currency)
);

CREATE TABLE watches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domains_json TEXT NOT NULL,
  include_registry INTEGER NOT NULL DEFAULT 1,
  provider_ids_json TEXT NOT NULL DEFAULT '[]',
  include_catalog_prices INTEGER NOT NULL DEFAULT 0,
  interval_minutes INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'paused')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT,
  next_run_at TEXT,
  missed_runs INTEGER NOT NULL DEFAULT 0,
  last_job_id TEXT
);
CREATE INDEX watches_due ON watches(state, next_run_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  label TEXT,
  input_json TEXT NOT NULL,
  destinations_json TEXT NOT NULL DEFAULT '[]',
  policy_json TEXT NOT NULL DEFAULT '{}',
  watch_id TEXT REFERENCES watches(id) ON DELETE SET NULL,
  parent_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  total INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 0,
  finished INTEGER NOT NULL DEFAULT 0,
  interrupted INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  unresolved INTEGER NOT NULL DEFAULT 0,
  outcomes_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  next_retry_at TEXT
);
CREATE INDEX jobs_created ON jobs(created_at DESC);
CREATE INDEX jobs_state ON jobs(state);

CREATE TABLE job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  subject TEXT NOT NULL,
  unicode TEXT NOT NULL,
  suffix TEXT,
  operation TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'finished', 'interrupted')),
  attempts INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  error_json TEXT,
  retry_at TEXT,
  not_before TEXT,
  registry_observation_id TEXT REFERENCES observations(id) ON DELETE SET NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, subject, operation, target)
);
CREATE INDEX job_items_job_seq ON job_items(job_id, seq);
CREATE INDEX job_items_job_state ON job_items(job_id, state);
CREATE INDEX job_items_job_outcome ON job_items(job_id, outcome);
CREATE INDEX job_items_subject ON job_items(subject);
CREATE INDEX job_items_pending ON job_items(state, not_before);

CREATE TABLE idempotency_requests (
  key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE watch_runs (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  changes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX watch_runs_watch ON watch_runs(watch_id, scheduled_for DESC);

CREATE TABLE notices (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX notices_watch ON notices(watch_id, created_at DESC);
CREATE INDEX notices_unread ON notices(read_at, created_at DESC);

-- Monotonic event log; written in the same transaction as the state it describes.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  job_id TEXT,
  watch_id TEXT,
  occurred_at TEXT NOT NULL,
  transient INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL
);
CREATE INDEX events_job ON events(job_id, id);
CREATE INDEX events_watch ON events(watch_id, id);
CREATE INDEX events_transient ON events(transient, occurred_at);

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE collection_entries (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  unicode TEXT NOT NULL,
  notes TEXT,
  added_at TEXT NOT NULL,
  UNIQUE (collection_id, domain)
);
CREATE INDEX collection_entries_domain ON collection_entries(domain);

CREATE TABLE saved_criteria (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE extension_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  extensions_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE portfolio_entries (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  registrar TEXT,
  renewal_date TEXT,
  renewal_amount TEXT,
  renewal_currency TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('export', 'snapshot')),
  title TEXT,
  format TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  item_count INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
`;

export const MIGRATIONS: Migration[] = [{ version: 1, name: 'initial', sql: INITIAL }];
