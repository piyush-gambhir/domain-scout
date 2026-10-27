import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, NewerDatabaseError } from '../../src/storage/database.js';

let dir: string;
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ds-db-'));
  db = new Database(join(dir, 'test.sqlite'));
  db.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE t (v TEXT)`);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Database.transaction', () => {
  it('surfaces a failed COMMIT, rolls back and leaves the connection usable', () => {
    // A deferred foreign key is only checked at COMMIT, so the outer commit itself fails.
    expect(() => db.transaction(() => db.run('INSERT INTO child (id, parent_id) VALUES (1, 99)'))).toThrow(/FOREIGN KEY/);
    expect(db.inTransaction).toBe(false);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM child')?.n).toBe(0);
    db.transaction(() => db.run("INSERT INTO t (v) VALUES ('after')"));
    expect(db.get<{ v: string }>('SELECT v FROM t')?.v).toBe('after');
  });

  it('rolls back only the inner savepoint when a nested callback throws', () => {
    db.transaction(() => {
      db.run("INSERT INTO t (v) VALUES ('outer')");
      expect(db.inTransaction).toBe(true);
      expect(() =>
        db.transaction(() => {
          db.run("INSERT INTO t (v) VALUES ('inner')");
          throw new Error('boom');
        }),
      ).toThrow('boom');
    });
    expect(db.all<{ v: string }>('SELECT v FROM t').map((r) => r.v)).toEqual(['outer']);
    expect(db.inTransaction).toBe(false);
  });

  it('rejects async callbacks without leaking depth', () => {
    expect(() => db.transaction(() => Promise.resolve(1))).toThrow(/synchronous/);
    expect(db.inTransaction).toBe(false);
  });
});

describe('Database.migrate', () => {
  it('refuses a database migrated by a newer Domain Scout', () => {
    const file = join(dir, 'app.sqlite');
    const fresh = new Database(file);
    const ran = fresh.migrate();
    fresh.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [Math.max(...ran) + 1, 'future', new Date().toISOString()]);
    fresh.close();
    const older = new Database(file);
    try {
      expect(() => older.migrate()).toThrow(NewerDatabaseError);
      expect(() => older.migrate()).toThrow(/newer Domain Scout \(schema \d+; this backend supports up to \d+\)/);
    } finally {
      older.close();
    }
  });
});
