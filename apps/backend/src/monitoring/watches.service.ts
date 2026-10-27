import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Notice, Watch, WatchCreate, WatchPatch } from '@domain-scout/contracts';
import type { z } from 'zod';
import { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { ProviderDirectory } from '../core/ports.js';
import { EventsService } from '../events/events.service.js';
import { EvidenceReader } from '../evidence/evidence-reader.service.js';
import { pageWindow } from '../evidence/paging.js';
import { Database, json } from '../storage/database.js';
import { SettingsService } from '../system/settings.service.js';
import {
  addMinutes,
  deleteWatchRows,
  toNotice,
  toRecord,
  toWatch,
  type NoticeRow,
  type WatchRecord,
  type WatchRow,
} from './watch-records.js';

type CreateBody = z.output<typeof WatchCreate>;
type PatchBody = z.output<typeof WatchPatch>;

interface RunRow {
  id: string;
  watch_id: string;
  status: string;
  scheduled_for: string;
  started_at: string | null;
  finished_at: string | null;
  job_id: string | null;
  changes: number;
  failures: number;
  note: string | null;
}

/** Watch definitions, runs and notices. Scheduling lives in WatchScheduler. */
@Injectable()
export class WatchesService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly events: EventsService,
    private readonly reader: EvidenceReader,
    private readonly settings: SettingsService,
    @Optional() private readonly providers?: ProviderDirectory,
  ) {}

  list(cursor: string | undefined, limit: number) {
    const page = pageWindow(cursor, limit);
    const total = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM watches')!.n;
    const rows = this.db.all<WatchRow>('SELECT * FROM watches ORDER BY created_at, id LIMIT ? OFFSET ?', [page.limit, page.offset]);
    return { items: rows.map((row) => this.present(toRecord(row))), nextCursor: page.next(rows.length, total), total };
  }

  record(id: string): WatchRecord {
    const row = this.db.get<WatchRow>('SELECT * FROM watches WHERE id = ?', [id]);
    if (!row) throw AppError.notFound('Watch');
    return toRecord(row);
  }

  find(id: string): WatchRecord | null {
    const row = this.db.get<WatchRow>('SELECT * FROM watches WHERE id = ?', [id]);
    return row ? toRecord(row) : null;
  }

  get(id: string): Watch {
    return this.present(this.record(id));
  }

  create(body: CreateBody): Watch {
    const domains = this.validateDomains(body.domains);
    this.validateSources(body.includeRegistry, body.providerIds, body.includeCatalogPrices);
    const id = randomUUID();
    const now = this.clock.iso();
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO watches (id, name, domains_json, include_registry, provider_ids_json, include_catalog_prices,
           interval_minutes, state, created_at, updated_at, last_run_at, next_run_at, missed_runs, last_job_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, 0, NULL)`,
        [
          id,
          body.name,
          json.stringify(domains),
          body.includeRegistry ? 1 : 0,
          json.stringify([...new Set(body.providerIds)]),
          body.includeCatalogPrices ? 1 : 0,
          body.intervalMinutes ?? this.settings.get().monitoring.defaultIntervalMinutes,
          now,
          now,
          // The first check is due right away so the watch has a fresh baseline.
          now,
        ],
      );
      return this.changed(id);
    });
  }

  patch(id: string, body: PatchBody): Watch {
    const current = this.record(id);
    const domains = body.domains ? this.validateDomains(body.domains) : current.domains;
    const includeRegistry = body.includeRegistry ?? current.includeRegistry;
    const providerIds = body.providerIds ? [...new Set(body.providerIds)] : current.providerIds;
    const includeCatalogPrices = body.includeCatalogPrices ?? current.includeCatalogPrices;
    this.validateSources(includeRegistry, providerIds, includeCatalogPrices);
    const interval = body.intervalMinutes ?? current.intervalMinutes;
    let nextRunAt = current.nextRunAt;
    if (current.state === 'active' && interval !== current.intervalMinutes) {
      const now = this.clock.iso();
      const candidate = current.lastRunAt ? addMinutes(current.lastRunAt, interval) : now;
      nextRunAt = candidate < now ? now : candidate;
    }
    return this.db.transaction(() => {
      this.db.run(
        `UPDATE watches SET name = ?, domains_json = ?, include_registry = ?, provider_ids_json = ?, include_catalog_prices = ?,
           interval_minutes = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
        [
          body.name ?? current.name,
          json.stringify(domains),
          includeRegistry ? 1 : 0,
          json.stringify(providerIds),
          includeCatalogPrices ? 1 : 0,
          interval,
          nextRunAt,
          this.clock.iso(),
          id,
        ],
      );
      return this.changed(id);
    });
  }

  /**
   * Removes the watch, its runs, notices and events. No event describes the deletion: the contract's
   * only watch event carries the full watch, which would put the deleted names back into replay.
   */
  delete(id: string) {
    this.record(id);
    this.db.transaction(() => {
      deleteWatchRows(this.db, this.events, [id]);
      // Not tagged with the watch id, so cleanup of that watch's events keeps this tombstone.
      this.events.emit('watch.deleted', { watchId: null }, { watchId: id, deletedAt: this.clock.iso() });
    });
  }

  pause(id: string): Watch {
    const current = this.record(id);
    if (current.state === 'paused') return this.present(current);
    return this.db.transaction(() => {
      this.db.run(`UPDATE watches SET state = 'paused', next_run_at = NULL, updated_at = ? WHERE id = ?`, [this.clock.iso(), id]);
      return this.changed(id);
    });
  }

  resume(id: string): Watch {
    const current = this.record(id);
    if (current.state === 'active') return this.present(current);
    const now = this.clock.iso();
    const candidate = current.lastRunAt ? addMinutes(current.lastRunAt, current.intervalMinutes) : now;
    return this.db.transaction(() => {
      this.db.run(`UPDATE watches SET state = 'active', next_run_at = ?, updated_at = ? WHERE id = ?`, [
        candidate < now ? now : candidate,
        now,
        id,
      ]);
      return this.changed(id);
    });
  }

  runs(id: string, cursor: string | undefined, limit: number) {
    this.record(id);
    const page = pageWindow(cursor, limit);
    const total = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM watch_runs WHERE watch_id = ?', [id])!.n;
    const rows = this.db.all<RunRow>(
      'SELECT * FROM watch_runs WHERE watch_id = ? ORDER BY scheduled_for DESC, started_at DESC, id LIMIT ? OFFSET ?',
      [id, page.limit, page.offset],
    );
    const items = rows.map((row) => ({
      id: row.id,
      watchId: row.watch_id,
      status: row.status as never,
      scheduledFor: row.scheduled_for,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      jobId: row.job_id,
      changes: row.changes,
      failures: row.failures,
      note: row.note,
    }));
    return { items, nextCursor: page.next(rows.length, total), total };
  }

  notices(query: { watchId?: string; unread?: 'true' | 'false'; cursor?: string; limit: number }) {
    const where: string[] = [];
    const params: string[] = [];
    if (query.watchId) {
      where.push('watch_id = ?');
      params.push(query.watchId);
    }
    if (query.unread === 'true') where.push('read_at IS NULL');
    if (query.unread === 'false') where.push('read_at IS NOT NULL');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = pageWindow(query.cursor, query.limit);
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notices ${clause}`, params)!.n;
    const rows = this.db.all<NoticeRow>(`SELECT * FROM notices ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
      ...params,
      page.limit,
      page.offset,
    ]);
    return { items: rows.map(toNotice) as Notice[], nextCursor: page.next(rows.length, total), total };
  }

  /** Marks the given notices, or all of them, read; `watchId` narrows either selection to one watch. */
  markRead(body: { ids?: string[]; all?: boolean; watchId?: string }) {
    if (!body.all && !body.ids?.length) throw AppError.invalid('Provide ids or all: true');
    if (body.watchId) this.record(body.watchId);
    const where = ['read_at IS NULL'];
    const params: string[] = [];
    if (!body.all) {
      where.push(`id IN (${body.ids!.map(() => '?').join(',')})`);
      params.push(...body.ids!);
    }
    if (body.watchId) {
      where.push('watch_id = ?');
      params.push(body.watchId);
    }
    const clause = where.join(' AND ');
    const now = this.clock.iso();
    this.db.transaction(() => {
      const affected = this.db.all<{ watch_id: string }>(`SELECT DISTINCT watch_id FROM notices WHERE ${clause}`, params);
      this.db.run(`UPDATE notices SET read_at = ? WHERE ${clause}`, [now, ...params]);
      for (const { watch_id } of affected) this.changed(watch_id);
    });
  }

  /** Emit watch.changed with the current state. Call inside the transaction that changed it. */
  changed(id: string, jobId?: string | null): Watch {
    const watch = this.get(id);
    this.events.emit('watch.changed', { watchId: id, jobId: jobId ?? null }, watch);
    return watch;
  }

  present(record: WatchRecord): Watch {
    const unread = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notices WHERE watch_id = ? AND read_at IS NULL', [
      record.id,
    ])!.n;
    return toWatch(record, this.destinations(record), unread, this.registryState(record.domains));
  }

  /** Watched names counted by the outcome of their latest registry observation, from any job. */
  registryState(domains: string[]): Watch['registry'] {
    const rows = this.db.all<{ outcome: string | null; n: number }>(
      `SELECT (SELECT o.outcome FROM observations o WHERE o.kind = 'registry' AND o.subject = d.value
               ORDER BY o.observed_at DESC, o.id DESC LIMIT 1) AS outcome, COUNT(*) AS n
         FROM json_each(?) d GROUP BY outcome`,
      [JSON.stringify(domains)],
    );
    const outcomes: Record<string, number> = {};
    let unchecked = 0;
    for (const row of rows) {
      if (row.outcome === null) unchecked = row.n;
      else outcomes[row.outcome] = row.n;
    }
    return { outcomes, unchecked };
  }

  /** Where a run sends the watched names: registry endpoints per suffix and the selected providers. */
  destinations(record: WatchRecord): string[] {
    const out: string[] = [];
    if (record.includeRegistry) {
      const suffixes = new Set(record.domains.map((d) => this.reader.normalize(d)?.suffix ?? d.slice(d.indexOf('.') + 1)));
      for (const suffix of suffixes) {
        const rule = this.db.get<{ endpoint: string | null }>('SELECT endpoint FROM suffix_rules WHERE suffix = ?', [suffix]);
        out.push(rule?.endpoint ?? `registry:${suffix}`);
      }
    }
    for (const id of record.providerIds) out.push(`provider:${id}`);
    return [...new Set(out)];
  }

  private validateDomains(domains: string[]): string[] {
    const invalid: { path: string; message: string }[] = [];
    const out: string[] = [];
    domains.forEach((domain, index) => {
      const normalized = this.reader.normalize(domain);
      if (!normalized) invalid.push({ path: `domains.${index}`, message: `Not a registrable domain: ${domain}` });
      else if (!out.includes(normalized.ascii)) out.push(normalized.ascii);
    });
    if (invalid.length) throw AppError.invalid('Some watched domains are not registrable domains', invalid);
    return out;
  }

  private validateSources(includeRegistry: boolean, providerIds: string[], includeCatalogPrices: boolean) {
    if (!includeRegistry && providerIds.length === 0) {
      throw AppError.invalid('A watch needs registry checks or at least one provider');
    }
    // The jobs engine refreshes catalogs only for the watch's providers.
    if (includeCatalogPrices && providerIds.length === 0) {
      throw AppError.invalid('Tracking catalog prices needs at least one provider');
    }
    if (this.providers) {
      const unknown = providerIds.filter((id) => !this.providers!.exists(id));
      if (unknown.length) throw AppError.invalid(`Unknown providers: ${unknown.join(', ')}`);
    }
  }
}
