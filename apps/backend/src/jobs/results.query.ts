import type { ResultFilterParsed } from '@domain-scout/contracts';
import type { SQLInputValue } from 'node:sqlite';

export interface BuiltQuery {
  sql: string;
  params: SQLInputValue[];
}

/** Keyset position: [seq] for input order, else [nullRank, sortValue, seq]. */
export type ResultKey = SQLInputValue[];

interface SortSpec {
  /** Sort expression; null sorts by input order only. */
  expr: string | null;
  /** Value standing in for NULL inside the keyset tuple (nulls are ordered by a separate flag). */
  fallback: string;
}

/** Registrable label length in visible characters: the Unicode text before the suffix, or the whole name. */
const LABEL_LENGTH = `(CASE WHEN i.suffix IS NULL OR instr(i.unicode, '.') = 0 THEN length(i.unicode) ELSE instr(i.unicode, '.') - 1 END)`;

const SORTS: Record<ResultFilterParsed['sort'], SortSpec> = {
  input: { expr: null, fallback: '0' },
  domain: { expr: 'i.subject', fallback: "''" },
  suffix: { expr: 'i.suffix', fallback: "''" },
  length: { expr: LABEL_LENGTH, fallback: '0' },
  outcome: { expr: 'i.outcome', fallback: "''" },
  checkedAt: { expr: 'COALESCE(ro.observed_at, i.finished_at)', fallback: "''" },
  // Decimal strings compare exactly as REAL for the 15 significant digits prices use.
  price: { expr: 'CAST(bp.amount AS REAL)', fallback: '0' },
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function marks(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

/**
 * SQL for one job's results under the shared ResultFilter. Every value is bound as a parameter;
 * only fixed fragments from this file are interpolated.
 *
 * Semantics: `resolved: false` means finished without a definitive answer (pending work is selected
 * with `states`); `maxPrice` keeps only items with a known best price at or below it; `confirmations`
 * matches the provider confirmation evidence recorded on the item itself, or, for items without
 * any (registry rows), the newest confirmation recorded for the domain by any provider.
 */
export class ResultQueryBuilder {
  private readonly sort: SortSpec;
  private readonly desc: boolean;

  constructor(
    private readonly jobId: string,
    private readonly filter: ResultFilterParsed,
    /** Currency of the best_prices row used for maxPrice and price sorting. */
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
      // The item's own confirmation evidence decides; items without any (registry rows) use the
      // newest confirmation recorded for the same domain from any provider. CROSS JOIN keeps
      // json_each as the outer loop, so each item does primary-key lookups of its own evidence
      // ids instead of scanning every confirmation.
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

  /** Keyset tuple expressions, ordered the same direction so one row comparison pages correctly. */
  private keyExprs(): string[] {
    const { expr, fallback } = this.sort;
    if (!expr) return ['i.seq'];
    // Nulls always last: rank 0 for values first in ascending order, rank 1 first when descending.
    const rank = this.desc ? `(${expr} IS NOT NULL)` : `(${expr} IS NULL)`;
    return [rank, `COALESCE(${expr}, ${fallback})`, 'i.seq'];
  }

  count(): BuiltQuery {
    const from = this.from();
    const where = this.where();
    return { sql: `SELECT COUNT(*) AS n ${from.sql} ${where.sql}`, params: [...from.params, ...where.params] };
  }

  /** Page of item rows plus their keyset values as _k0.._kN. Fetches `limit` rows after `after`. */
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

  /** Every matching item id in result order (exports resolve their scope with this). */
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
