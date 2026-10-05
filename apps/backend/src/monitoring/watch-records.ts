import type { Notice, Watch } from '@domain-scout/contracts';
import { json } from '../storage/database.js';

export interface WatchRow {
  id: string;
  name: string;
  domains_json: string;
  include_registry: number;
  provider_ids_json: string;
  include_catalog_prices: number;
  interval_minutes: number;
  state: 'active' | 'paused';
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
  missed_runs: number;
  last_job_id: string | null;
}

/** Parsed watch row used by the scheduler and change detection. */
export interface WatchRecord {
  id: string;
  name: string;
  domains: string[];
  includeRegistry: boolean;
  providerIds: string[];
  includeCatalogPrices: boolean;
  intervalMinutes: number;
  state: 'active' | 'paused';
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  missedRuns: number;
  lastJobId: string | null;
}

export function toRecord(row: WatchRow): WatchRecord {
  return {
    id: row.id,
    name: row.name,
    domains: json.parse<string[]>(row.domains_json, []),
    includeRegistry: row.include_registry === 1,
    providerIds: json.parse<string[]>(row.provider_ids_json, []),
    includeCatalogPrices: row.include_catalog_prices === 1,
    intervalMinutes: row.interval_minutes,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    missedRuns: row.missed_runs,
    lastJobId: row.last_job_id,
  };
}

export function toWatch(record: WatchRecord, destinations: string[], unreadNotices: number): Watch {
  return { ...record, destinations, unreadNotices };
}

export interface NoticeRow {
  id: string;
  watch_id: string;
  domain: string;
  type: Notice['type'];
  summary: string;
  before_json: string;
  after_json: string;
  dedupe_key: string;
  created_at: string;
  read_at: string | null;
}

export function toNotice(row: NoticeRow): Notice {
  return {
    id: row.id,
    watchId: row.watch_id,
    domain: row.domain,
    type: row.type,
    summary: row.summary,
    before: json.parse<Notice['before']>(row.before_json, {} as Notice['before']),
    after: json.parse<Notice['after']>(row.after_json, {} as Notice['after']),
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export const MINUTE_MS = 60_000;

export function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * MINUTE_MS).toISOString();
}
