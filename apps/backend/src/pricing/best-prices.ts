import type { Database } from '../storage/database.js';
import { CURRENT_PUBLISHED, LATEST_FETCH_CTE, LATEST_FETCH_JOIN } from './current-catalog.js';
import { compare } from './money.js';

interface Candidate {
  provider_id: string;
  suffix: string;
  currency: string;
  registration: string;
  term_years: number;
  observed_at: string;
  preferred: number;
}

/**
 * Rebuilds best_prices: the lowest published first-year registration per suffix and currency among
 * enabled providers, using each provider's current published price for the suffix and currency
 * (see current-catalog.ts). Prices are compared as decimals; ties go to a preferred provider, then
 * the provider id. Call inside the transaction that changed catalogs or preferences. Job results
 * find the offer behind each row with the same selection (see JobResultsService).
 */
export function recomputeBestPrices(db: Database): number {
  const rows = db.all<Candidate>(
    `WITH ${LATEST_FETCH_CTE},
     latest AS (
       SELECT o.provider_id, o.suffix, o.currency, o.registration, o.term_years, o.observed_at,
              ROW_NUMBER() OVER (PARTITION BY o.provider_id, o.suffix, o.currency, o.term_years ORDER BY o.observed_at DESC, o.rowid DESC) AS rn
       FROM offers o
       ${LATEST_FETCH_JOIN}
       WHERE o.kind = 'published' AND o.domain IS NULL AND o.purchase_path = 'new_registration' AND ${CURRENT_PUBLISHED}
     )
     SELECT l.provider_id, l.suffix, l.currency, l.registration, l.term_years, l.observed_at, p.preferred
     FROM latest l
     JOIN providers p ON p.id = l.provider_id AND p.enabled = 1
     WHERE l.rn = 1 AND l.registration IS NOT NULL AND l.term_years = 1`,
  );
  const best = new Map<string, Candidate>();
  for (const row of rows) {
    const key = `${row.suffix}\u0000${row.currency}`;
    const current = best.get(key);
    if (!current) {
      best.set(key, row);
      continue;
    }
    const order = compare(row.registration, current.registration);
    const wins =
      order < 0 ||
      (order === 0 && (row.preferred > current.preferred || (row.preferred === current.preferred && row.provider_id < current.provider_id)));
    if (wins) best.set(key, row);
  }
  db.run('DELETE FROM best_prices');
  for (const row of best.values()) {
    db.run(
      'INSERT INTO best_prices (suffix, currency, provider_id, amount, years, kind, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [row.suffix, row.currency, row.provider_id, row.registration, row.term_years, 'published', row.observed_at],
    );
  }
  return best.size;
}
