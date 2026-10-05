import { Inject, Injectable } from '@nestjs/common';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runtimePaths } from '../runtime/paths.js';
import { APP_CONFIG, type AppConfig } from '../core/config.js';
import { AppError } from '../core/errors.js';
import { Database, json } from '../storage/database.js';

export interface ArtifactRow {
  id: string;
  kind: 'export' | 'snapshot';
  title: string | null;
  format: string;
  scope_json: string;
  options_json: string;
  item_count: number;
  file_name: string;
  size_bytes: number;
  warnings_json: string;
  created_at: string;
}

export interface ArtifactInsert {
  id: string;
  kind: 'export' | 'snapshot';
  title: string | null;
  format: string;
  scope: unknown;
  options: unknown;
  itemCount: number;
  fileName: string;
  sizeBytes: number;
  warnings: string[];
  createdAt: string;
}

/** Artifact files under <dataDir>/artifacts with their metadata in the artifacts table. */
@Injectable()
export class ArtifactStore {
  constructor(
    private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get dir(): string {
    return runtimePaths(this.config.dataDir).artifactsDir;
  }

  /** Writes a file and returns its size. Names are generated, never taken from user input. */
  write(fileName: string, content: string): number {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, basename(fileName));
    writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
    return statSync(path).size;
  }

  read(fileName: string): Buffer {
    try {
      return readFileSync(join(this.dir, basename(fileName)));
    } catch {
      throw AppError.notFound('Artifact file');
    }
  }

  remove(fileName: string) {
    rmSync(join(this.dir, basename(fileName)), { force: true });
  }

  insert(row: ArtifactInsert) {
    this.db.run(
      `INSERT INTO artifacts (id, kind, title, format, scope_json, options_json, item_count, file_name, size_bytes, warnings_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.kind,
        row.title,
        row.format,
        json.stringify(row.scope),
        json.stringify(row.options),
        row.itemCount,
        row.fileName,
        row.sizeBytes,
        json.stringify(row.warnings),
        row.createdAt,
      ],
    );
  }

  list(kind: 'export' | 'snapshot'): ArtifactRow[] {
    return this.db.all<ArtifactRow>('SELECT * FROM artifacts WHERE kind = ? ORDER BY created_at DESC, id DESC', [kind]);
  }

  get(kind: 'export' | 'snapshot', id: string): ArtifactRow {
    const row = this.db.get<ArtifactRow>('SELECT * FROM artifacts WHERE kind = ? AND id = ?', [kind, id]);
    if (!row) throw AppError.notFound(kind === 'export' ? 'Export' : 'Snapshot');
    return row;
  }

  delete(kind: 'export' | 'snapshot', id: string, files: string[]) {
    this.get(kind, id);
    this.db.run('DELETE FROM artifacts WHERE id = ?', [id]);
    for (const file of files) this.remove(file);
  }
}

/** Compact UTC stamp for file names, e.g. 20261005T120000Z. */
export function fileStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
