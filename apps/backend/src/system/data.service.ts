import { Inject, Injectable } from '@nestjs/common';
import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TERMINAL_JOB_STATES, type DataCategory } from '@domain-scout/contracts';
import { APP_CONFIG, type AppConfig } from '../core/config.js';
import { AppError } from '../core/errors.js';
import { EventsService } from '../events/events.service.js';
import { runtimePaths } from '../runtime/paths.js';
import { Database, json } from '../storage/database.js';
import { DATABASE_FILE } from '../storage/storage.module.js';

/**
 * What each category covers (counts are rows of the listed tables):
 * - jobs: finished jobs with their items and idempotency keys (active jobs are never deleted)
 * - registry_evidence / name_checks / diagnostics: observations of that kind (raw responses cascade)
 * - provider_evidence: provider confirmations and aftermarket listings
 * - price_history: offers (catalog prices and exact quotes), catalog fetch records, derived best prices
 * - raw_diagnostics: retained raw responses only (observations stay)
 * - collections: shortlists and their entries; criteria: saved criteria and extension presets
 * - watches: watches with their runs and notices; portfolio: imported portfolio entries
 * - artifacts: export and snapshot records and their files under <dataDir>/artifacts
 */
const COUNT_SQL: Record<DataCategory, string> = {
  jobs: 'SELECT COUNT(*) AS n FROM jobs',
  registry_evidence: "SELECT COUNT(*) AS n FROM observations WHERE kind = 'registry'",
  provider_evidence: "SELECT COUNT(*) AS n FROM observations WHERE kind IN ('confirmation', 'listing')",
  price_history: 'SELECT COUNT(*) AS n FROM offers',
  name_checks: "SELECT COUNT(*) AS n FROM observations WHERE kind = 'name_check'",
  diagnostics: "SELECT COUNT(*) AS n FROM observations WHERE kind = 'diagnostic'",
  raw_diagnostics: 'SELECT COUNT(*) AS n FROM raw_diagnostics',
  collections: 'SELECT COUNT(*) AS n FROM collections',
  criteria: 'SELECT (SELECT COUNT(*) FROM saved_criteria) + (SELECT COUNT(*) FROM extension_presets) AS n',
  watches: 'SELECT COUNT(*) AS n FROM watches',
  portfolio: 'SELECT COUNT(*) AS n FROM portfolio_entries',
  artifacts: 'SELECT COUNT(*) AS n FROM artifacts',
};

const OBSERVATION_KINDS: Partial<Record<DataCategory, string[]>> = {
  registry_evidence: ['registry'],
  provider_evidence: ['confirmation', 'listing'],
  name_checks: ['name_check'],
  diagnostics: ['diagnostic'],
};

const CHUNK = 500;

export interface DataDeleteInput {
  categories: DataCategory[];
  collectionIds?: string[];
  before?: string;
}

/** Local data inventory and scoped deletion that preserves unrelated records. */
@Injectable()
export class DataService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Database,
    private readonly events: EventsService,
  ) {}

  inventory() {
    return {
      dataDir: this.config.dataDir,
      databaseBytes: this.databaseBytes(),
      categories: (Object.keys(COUNT_SQL) as DataCategory[]).map((category) => ({
        category,
        count: this.db.get<{ n: number }>(COUNT_SQL[category])?.n ?? 0,
      })),
    };
  }

  /** Database file plus its active WAL and shared-memory files. */
  databaseBytes(): number {
    if (this.config.dataDir === ':memory:') return 0;
    const base = resolve(this.config.dataDir, DATABASE_FILE);
    return ['', '-wal', '-shm'].reduce((sum, suffix) => {
      try {
        return sum + statSync(base + suffix).size;
      } catch {
        return sum;
      }
    }, 0);
  }

  delete(input: DataDeleteInput) {
    const categories = [...new Set(input.categories)];
    if (input.collectionIds && !categories.includes('collections')) {
      throw AppError.invalid('collectionIds requires the collections category', [
        { path: 'body.collectionIds', message: 'Only valid together with the collections category' },
      ]);
    }
    const before = input.before ? new Date(input.before).toISOString() : null;
    const artifactFiles: string[] = [];
    let wipeArtifacts = false;

    // secure_delete zeroes freed pages so removed data does not linger in the database file.
    const previous = this.db.get<{ secure_delete: number }>('PRAGMA secure_delete')?.secure_delete ?? 0;
    this.db.exec('PRAGMA secure_delete = ON');
    let deleted: { category: DataCategory; count: number }[];
    try {
      deleted = this.db.transaction(() =>
        categories.map((category) => {
          if (category === 'artifacts') {
            const result = this.deleteArtifactRows(before);
            artifactFiles.push(...result.files);
            wipeArtifacts = before === null;
            return { category, count: result.count };
          }
          return { category, count: this.deleteCategory(category, before, input.collectionIds) };
        }),
      );
    } catch (error) {
      if (/FOREIGN KEY/i.test((error as Error).message)) {
        throw AppError.conflict('Deletion would break references from other records; nothing was deleted');
      }
      throw error;
    } finally {
      this.db.exec(`PRAGMA secure_delete = ${previous ? 'ON' : 'OFF'}`);
    }

    // Files go after the commit: a failed unlink leaves an orphan file, never a dangling record.
    if (categories.includes('artifacts')) this.removeArtifactFiles(artifactFiles, wipeArtifacts);
    this.db.checkpoint();
    return { deleted };
  }

  private deleteCategory(category: DataCategory, before: string | null, collectionIds?: string[]): number {
    const kinds = OBSERVATION_KINDS[category];
    if (kinds) {
      return this.run(
        `DELETE FROM observations WHERE kind IN (${kinds.map(() => '?').join(',')})`,
        kinds,
        'observed_at',
        before,
      );
    }
    switch (category) {
      case 'jobs':
        return this.deleteJobs(before);
      case 'raw_diagnostics':
        return this.run('DELETE FROM raw_diagnostics WHERE 1 = 1', [], 'created_at', before);
      case 'price_history': {
        const offers = this.run('DELETE FROM offers WHERE 1 = 1', [], 'observed_at', before);
        this.run('DELETE FROM catalog_fetches WHERE 1 = 1', [], 'fetched_at', before);
        this.run('DELETE FROM best_prices WHERE 1 = 1', [], 'observed_at', before);
        return offers;
      }
      case 'collections': {
        // Entries cascade; the evidence they pointed at is kept.
        if (!collectionIds) return this.run('DELETE FROM collections WHERE 1 = 1', [], 'created_at', before);
        let count = 0;
        for (const chunk of chunks(collectionIds)) {
          count += this.run(`DELETE FROM collections WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk, 'created_at', before);
        }
        return count;
      }
      case 'criteria':
        return (
          this.run('DELETE FROM saved_criteria WHERE 1 = 1', [], 'created_at', before) +
          this.run('DELETE FROM extension_presets WHERE 1 = 1', [], 'created_at', before)
        );
      case 'watches':
        return this.deleteWatches(before);
      case 'portfolio':
        return this.run('DELETE FROM portfolio_entries WHERE 1 = 1', [], 'created_at', before);
      default:
        return 0;
    }
  }

  /** Finished jobs only; running work belongs to the jobs engine. Items and idempotency keys cascade. */
  private deleteJobs(before: string | null): number {
    const states = TERMINAL_JOB_STATES as readonly string[];
    const ids = this.ids(
      `SELECT id FROM jobs WHERE state IN (${states.map(() => '?').join(',')})${before ? ' AND created_at < ?' : ''}`,
      before ? [...states, before] : [...states],
    );
    let count = 0;
    for (const chunk of chunks(ids)) {
      const marks = chunk.map(() => '?').join(',');
      this.db.run(`UPDATE watches SET last_job_id = NULL WHERE last_job_id IN (${marks})`, chunk);
      this.events.deleteFor({ jobIds: chunk });
      count += this.db.run(`DELETE FROM jobs WHERE id IN (${marks})`, chunk).changes;
    }
    return count;
  }

  /** Watches with their runs and notices; jobs they started stay, detached from the watch. */
  private deleteWatches(before: string | null): number {
    const ids = this.ids(`SELECT id FROM watches${before ? ' WHERE created_at < ?' : ''}`, before ? [before] : []);
    let count = 0;
    for (const chunk of chunks(ids)) {
      this.events.deleteFor({ watchIds: chunk });
      count += this.db.run(`DELETE FROM watches WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk).changes;
    }
    return count;
  }

  private deleteArtifactRows(before: string | null): { count: number; files: string[] } {
    const rows = this.db.all<{ id: string; file_name: string; options_json: string }>(
      `SELECT id, file_name, options_json FROM artifacts${before ? ' WHERE created_at < ?' : ''}`,
      before ? [before] : [],
    );
    let count = 0;
    for (const chunk of chunks(rows.map((r) => r.id))) {
      count += this.db.run(`DELETE FROM artifacts WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk).changes;
    }
    // Snapshots keep a second (JSON) file whose name the exports module records in options_json.
    const extra = (r: { options_json: string }) => {
      const file = json.parse<{ jsonFile?: unknown }>(r.options_json, {}).jsonFile;
      return typeof file === 'string' ? [file] : [];
    };
    return { count, files: rows.flatMap((r) => [r.file_name, r.id, ...extra(r)]) };
  }

  /**
   * Removes artifact files that are direct entries of <dataDir>/artifacts (the exports module stores
   * basenames only). Each name is matched exactly and as an id prefix (`<id>.html`). Without a time
   * bound every entry goes. Path-like names are ignored, and rm never follows a symlinked entry, so
   * nothing outside the directory can be reached.
   */
  private removeArtifactFiles(names: string[], wipe: boolean) {
    const root = runtimePaths(this.config.dataDir).artifactsDir;
    try {
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    } catch {
      return;
    }
    const wanted = names.filter((name) => name && !/[\\/]/.test(name) && name !== '.' && name !== '..');
    for (const entry of readdirSync(root)) {
      if (!wipe && !wanted.some((name) => entry === name || entry.startsWith(`${name}.`))) continue;
      rmSync(join(root, entry), { recursive: true, force: true });
    }
  }

  private run(sql: string, params: string[], timeColumn: string, before: string | null): number {
    return before
      ? this.db.run(`${sql} AND ${timeColumn} < ?`, [...params, before]).changes
      : this.db.run(sql, params).changes;
  }

  private ids(sql: string, params: string[]): string[] {
    return this.db.all<{ id: string }>(sql, params).map((r) => r.id);
  }
}

function chunks<T>(values: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += CHUNK) out.push(values.slice(i, i + CHUNK));
  return out;
}
