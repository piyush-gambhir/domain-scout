import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type SqlParams = Record<string, SQLInputValue> | SQLInputValue[];
type Row = Record<string, unknown>;


export class NewerDatabaseError extends Error {
  constructor(
    readonly schemaVersion: number,
    readonly supportedVersion: number,
  ) {
    super(
      `the database was written by a newer Domain Scout (schema ${schemaVersion}; this backend supports up to ${supportedVersion}). ` +
        'Use the newer domain-scout, or another data directory.',
    );
    this.name = 'NewerDatabaseError';
  }
}





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


  get inTransaction(): boolean {
    return this.depth > 0;
  }


  transaction<T>(fn: () => T): T {


    const depth = this.depth;
    const savepoint = `sp_${depth}`;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth = depth + 1;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('Database.transaction callbacks must be synchronous');
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      try {
        if (depth > 0) this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);

        else if (this.db.isTransaction) this.db.exec('ROLLBACK');
      } catch {

      }
      throw error;
    } finally {
      this.depth = depth;
    }
  }

  migrate(now = new Date().toISOString()): number[] {
    this.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    const applied = new Set(this.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));

    const latest = Math.max(...MIGRATIONS.map((m) => m.version));
    const newest = Math.max(0, ...applied);
    if (newest > latest) throw new NewerDatabaseError(newest, latest);
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


  checkpoint() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close() {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }
}


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
