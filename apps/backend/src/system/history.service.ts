import { Injectable } from '@nestjs/common';
import type { JobOrigin, JobType } from '@domain-scout/contracts';
import { decodeCursor, encodeCursor } from '../core/envelope.js';
import { Database, json } from '../storage/database.js';

export interface HistoryEntry {
  jobId: string;
  type: JobType;
  origin: JobOrigin;
  label: string | null;
  state: string;
  createdAt: string;
  finishedAt: string | null;
  total: number;
  unresolved: number;
  extensions: string[];
  destinations: string[];
  resumable: boolean;
}

interface JobRow {
  id: string;
  type: JobType;
  origin: JobOrigin;
  label: string | null;
  state: string;
  input_json: string;
  destinations_json: string;
  total: number;
  unresolved: number;
  created_at: string;
  finished_at: string | null;
  resumable: number;
}

type Cursor = { createdAt: string; id: string };

/** Escapes LIKE wildcards so user text matches literally. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Past jobs, newest first, read straight from the shared jobs schema. */
@Injectable()
export class HistoryService {
  constructor(private readonly db: Database) {}

  list(query: { q?: string; type?: string; origins?: string; cursor?: string; limit: number }) {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.type) {
      where.push('j.type = ?');
      params.push(query.type);
    }
    const origins = (query.origins ?? '').split(',').map((o) => o.trim()).filter(Boolean);
    if (origins.length) {
      where.push(`j.origin IN (${origins.map(() => '?').join(', ')})`);
      params.push(...origins);
    }
    const q = query.q?.trim();
    if (q) {
      const pattern = likePattern(q.toLowerCase());
      // Label, or any item subject (ASCII domain or name) or its Unicode form.
      where.push(`(j.label LIKE ? ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM job_items i WHERE i.job_id = j.id AND (i.subject LIKE ? ESCAPE '\\' OR i.unicode LIKE ? ESCAPE '\\')))`);
      params.push(pattern, pattern, likePattern(q));
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs j ${filter}`, params)?.n ?? 0;

    const cursor = decodeCursor<Cursor>(query.cursor);
    const pageWhere = [...where];
    const pageParams = [...params];
    if (cursor?.createdAt && cursor.id) {
      pageWhere.push('(j.created_at < ? OR (j.created_at = ? AND j.id < ?))');
      pageParams.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const rows = this.db.all<JobRow>(
      `SELECT j.id, j.type, j.origin, j.label, j.state, j.input_json, j.destinations_json, j.total, j.unresolved, j.created_at, j.finished_at,
         (j.state IN ('interrupted', 'cancelled') AND EXISTS (
           SELECT 1 FROM job_items r WHERE r.job_id = j.id AND r.state IN ('pending', 'interrupted'))) AS resumable
       FROM jobs j ${pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : ''}
       ORDER BY j.created_at DESC, j.id DESC LIMIT ?`,
      [...pageParams, query.limit + 1],
    );
    const more = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const fallback = this.itemSuffixes(page.filter((row) => declaredExtensions(row.input_json).length === 0).map((r) => r.id));
    const items: HistoryEntry[] = page.map((row) => {
      const declared = declaredExtensions(row.input_json);
      return {
        jobId: row.id,
        type: row.type,
        origin: row.origin,
        label: row.label,
        state: row.state,
        createdAt: row.created_at,
        finishedAt: row.finished_at,
        total: row.total,
        unresolved: row.unresolved,
        extensions: declared.length ? declared : (fallback.get(row.id) ?? []),
        destinations: json.parse<string[]>(row.destinations_json, []),
        resumable: row.resumable === 1,
      };
    });
    return { items, nextCursor: more && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null, total };
  }

  /** Distinct item suffixes for jobs whose input declared no extensions (e.g. full domains). */
  private itemSuffixes(jobIds: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (jobIds.length === 0) return out;
    const rows = this.db.all<{ job_id: string; suffix: string }>(
      `SELECT DISTINCT job_id, suffix FROM job_items WHERE job_id IN (${jobIds.map(() => '?').join(',')}) AND suffix IS NOT NULL
       ORDER BY job_id, suffix`,
      jobIds,
    );
    for (const row of rows) out.set(row.job_id, [...(out.get(row.job_id) ?? []), row.suffix]);
    return out;
  }
}

/** Extensions the user selected: `extensions` or `input.extensions` in the stored request. */
function declaredExtensions(inputJson: string): string[] {
  const input = json.parse<Record<string, unknown>>(inputJson, {});
  const nested = (input.input as Record<string, unknown> | undefined)?.extensions;
  const value = Array.isArray(input.extensions) ? input.extensions : Array.isArray(nested) ? nested : [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string'))];
}
