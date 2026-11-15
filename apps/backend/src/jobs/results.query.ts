import type { ResultFilterParsed } from '@domain-scout/contracts';
import type { SQLInputValue } from 'node:sqlite';

export interface BuiltQuery {
  sql: string;
  params: SQLInputValue[];
}


export type ResultKey = SQLInputValue[];

interface SortSpec {

  expr: string | null;

  fallback: string;
}


const LABEL_LENGTH = `(CASE WHEN i.suffix IS NULL OR instr(i.unicode, '.') = 0 THEN length(i.unicode) ELSE instr(i.unicode, '.') - 1 END)`;

const statusRank = (payload: string) =>
  `CASE json_extract(${payload}, '$.status') WHEN 'available' THEN 0 WHEN 'restricted' THEN 1 WHEN 'unknown' THEN 2 WHEN 'unavailable' THEN 3 END`;


const CONFIRMATION_RANK = `COALESCE(
  (SELECT ${statusRank('co.payload_json')} FROM json_each(i.evidence_json, '$.observations') je
     CROSS JOIN observations co ON co.id = je.value WHERE co.kind = 'confirmation' LIMIT 1),
  (SELECT ${statusRank('lc.payload_json')} FROM observations lc
     WHERE lc.kind = 'confirmation' AND lc.subject = i.subject ORDER BY lc.observed_at DESC, lc.id DESC LIMIT 1))`;

const SORTS: Record<ResultFilterParsed['sort'], SortSpec> = {
  input: { expr: null, fallback: '0' },
  domain: { expr: 'i.subject', fallback: "''" },
  suffix: { expr: 'i.suffix', fallback: "''" },
  length: { expr: LABEL_LENGTH, fallback: '0' },
  outcome: { expr: 'i.outcome', fallback: "''" },
  checkedAt: { expr: 'COALESCE(ro.observed_at, i.finished_at)', fallback: "''" },

  price: { expr: 'CAST(bp.amount AS REAL)', fallback: '0' },
  confirmation: { expr: CONFIRMATION_RANK, fallback: '0' },
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function marks(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}










export class ResultQueryBuilder {
  private readonly sort: SortSpec;
  private readonly desc: boolean;

  constructor(
    private readonly jobId: string,
    private readonly filter: ResultFilterParsed,

    private readonly priceCurrency: string,
  ) {
    this.sort = SORTS[filter.sort] ?? SORTS.input;
    this.desc = filter.order === 'desc';
  }

  private needsPrice(): boolean {
    return this.filter.maxPrice !== undefined || this.filter.sort === 'price';
  }

  private from(): BuiltQuery {
    const joins: string[] = [];
    const params: SQLInputValue[] = [];
    if (this.needsPrice()) {
      joins.push('LEFT JOIN best_prices bp ON bp.suffix = i.suffix AND bp.currency = ?');
      params.push(this.priceCurrency);
    }
    if (this.filter.sort === 'checkedAt') joins.push('LEFT JOIN observations ro ON ro.id = i.registry_observation_id');
    return { sql: `FROM job_items i ${joins.join(' ')}`, params };
  }

  private where(): BuiltQuery {
    const f = this.filter;
    const clauses = ['i.job_id = ?'];
    const params: SQLInputValue[] = [this.jobId];
    if (f.q && f.q.trim() !== '') {
      const like = `%${escapeLike(f.q.trim().toLowerCase())}%`;
      clauses.push(`(i.subject LIKE ? ESCAPE '\\' OR i.unicode LIKE ? ESCAPE '\\')`);
      params.push(like, like);
    }
    if (f.outcomes?.length) {
      clauses.push(`i.outcome IN (${marks(f.outcomes)})`);
      params.push(...f.outcomes);
    }
    if (f.suffixes?.length) {
      clauses.push(`i.suffix IN (${marks(f.suffixes)})`);
      params.push(...f.suffixes);
    }
    if (f.states?.length) {
      clauses.push(`i.state IN (${marks(f.states)})`);
      params.push(...f.states);
    }
    if (f.resolved !== undefined) {
      clauses.push(`i.state = 'finished' AND i.resolved = ?`);
      params.push(f.resolved ? 1 : 0);
    }
    if (f.confirmations?.length) {




      const own = `SELECT 1 FROM json_each(i.evidence_json, '$.observations') je
           CROSS JOIN observations co ON co.id = je.value
           WHERE co.kind = 'confirmation'`;
      clauses.push(
        `(EXISTS (${own} AND json_extract(co.payload_json, '$.status') IN (${marks(f.confirmations)}))
          OR (NOT EXISTS (${own})
            AND (SELECT json_extract(lc.payload_json, '$.status') FROM observations lc
                 WHERE lc.kind = 'confirmation' AND lc.subject = i.subject
                 ORDER BY lc.observed_at DESC, lc.id DESC LIMIT 1) IN (${marks(f.confirmations)})))`,
      );
      params.push(...f.confirmations, ...f.confirmations);
    }
    if (f.maxPrice !== undefined) {
      clauses.push('bp.amount IS NOT NULL AND CAST(bp.amount AS REAL) <= CAST(? AS REAL)');
      params.push(f.maxPrice);
    }
    if (f.maxLength !== undefined) {
      clauses.push(`${LABEL_LENGTH} <= ?`);
      params.push(f.maxLength);
    }
    if (f.inCollection !== undefined) {
      clauses.push(`${f.inCollection ? '' : 'NOT '}EXISTS (SELECT 1 FROM collection_entries ce WHERE ce.domain = i.subject)`);
    }
    if (f.collectionId) {
      clauses.push('EXISTS (SELECT 1 FROM collection_entries ce WHERE ce.collection_id = ? AND ce.domain = i.subject)');
      params.push(f.collectionId);
    }
    return { sql: `WHERE ${clauses.join(' AND ')}`, params };
  }


  private keyExprs(): string[] {
    const { expr, fallback } = this.sort;
    if (!expr) return ['i.seq'];

    const rank = this.desc ? `(${expr} IS NOT NULL)` : `(${expr} IS NULL)`;
    return [rank, `COALESCE(${expr}, ${fallback})`, 'i.seq'];
  }

  count(): BuiltQuery {
    const from = this.from();
    const where = this.where();
    return { sql: `SELECT COUNT(*) AS n ${from.sql} ${where.sql}`, params: [...from.params, ...where.params] };
  }


  page(after: ResultKey | null, limit: number): BuiltQuery {
    const from = this.from();
    const where = this.where();
    const keys = this.keyExprs();
    const dir = this.desc ? 'DESC' : 'ASC';
    let sql = `SELECT i.*, ${keys.map((k, n) => `${k} AS _k${n}`).join(', ')} ${from.sql} ${where.sql}`;
    const params = [...from.params, ...where.params];
    if (after) {
      sql += ` AND (${keys.join(', ')}) ${this.desc ? '<' : '>'} (${marks(keys)})`;
      params.push(...after);
    }
    sql += ` ORDER BY ${keys.map((k) => `${k} ${dir}`).join(', ')} LIMIT ?`;
    params.push(limit);
    return { sql, params };
  }


  ids(): BuiltQuery {
    const from = this.from();
    const where = this.where();
    const keys = this.keyExprs();
    const dir = this.desc ? 'DESC' : 'ASC';
    return {
      sql: `SELECT i.id ${from.sql} ${where.sql} ORDER BY ${keys.map((k) => `${k} ${dir}`).join(', ')}`,
      params: [...from.params, ...where.params],
    };
  }

  keyLength(): number {
    return this.keyExprs().length;
  }
}
