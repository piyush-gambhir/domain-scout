import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type SqlParams = Record<string, SQLInputValue> | SQLInputValue[];
type Row = Record<string, unknown>;

/**
 * Thin synchronous wrapper over node:sqlite. One backend process owns the database.
 * Keep transactions short: the driver is synchronous and blocks the event loop while it runs.
 */
export class Database {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  private statement(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  private bind(stmt: StatementSync, params: SqlParams | undefined, fn: 'get' | 'all' | 'run') {
    if (params === undefined) return stmt[fn]();
    if (Array.isArray(params)) return stmt[fn](...params);
    return stmt[fn](params);
  }

  get<T = Row>(sql: string, params?: SqlParams): T | undefined {
    return this.bind(this.statement(sql), params, 'get') as T | undefined;
  }

  all<T = Row>(sql: string, params?: SqlParams): T[] {
    return this.bind(this.statement(sql), params, 'all') as T[];
  }

  run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number } {
    const result = this.bind(this.statement(sql), params, 'run') as { changes: number | bigint; lastInsertRowid: number | bigint };
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  exec(sql: string) {
    this.db.exec(sql);
  }

  /** Runs `fn` in a transaction. Nested calls use savepoints. `fn` must be synchronous. */
  transaction<T>(fn: () => T): T {
    const savepoint = `sp_${this.depth}`;
    this.db.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('Database.transaction callbacks must be synchronous');
      this.depth--;
      this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.depth--;
      this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  migrate(now = new Date().toISOString()): number[] {
    this.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    const applied = new Set(this.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
    const ran: number[] = [];
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.exec(migration.sql);
        this.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
          migration.version,
          migration.name,
          now,
        ]);
      });
      ran.push(migration.version);
    }
    return ran;
  }

  /** Flush the WAL into the main file, e.g. before shutdown or after large deletions. */
  checkpoint() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close() {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }
}

/** JSON column helpers. */
export const json = {
  stringify(value: unknown): string {
    return JSON.stringify(value ?? null);
  },
  parse<T>(text: unknown, fallback: T): T {
    if (typeof text !== 'string' || text === '') return fallback;
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  },
};
