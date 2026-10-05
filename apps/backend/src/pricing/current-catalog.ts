/**
 * Which suffix-level (published) offers are current, shared by every reader of catalog prices so
 * offers, best prices, job results, domain evidence and exports agree.
 *
 * After a provider's latest successful catalog, only that catalog's rows count, plus suffix prices
 * recorded after it (for example alongside a quote) for suffixes the catalog still lists. A provider
 * without a successful catalog has every row current. A failed refresh adds no successful fetch, so
 * earlier values stay current and age into stale through their stored staleAt.
 *
 * Usage: `WITH ${LATEST_FETCH_CTE} ... FROM offers o LEFT JOIN latest_fetch lf ON lf.provider_id =
 * o.provider_id WHERE ... AND ${CURRENT_PUBLISHED}`.
 */
export const LATEST_FETCH_CTE = `latest_fetch AS (
  SELECT provider_id, id, fetched_at FROM (
    SELECT provider_id, id, fetched_at,
           ROW_NUMBER() OVER (PARTITION BY provider_id ORDER BY fetched_at DESC, rowid DESC) AS fetch_rn
    FROM catalog_fetches WHERE status = 'ok'
  ) WHERE fetch_rn = 1
)`;

/** Join that pairs offers `o` with their provider's latest successful catalog `lf`. */
export const LATEST_FETCH_JOIN = 'LEFT JOIN latest_fetch lf ON lf.provider_id = o.provider_id';

/** Predicate over offers `o` joined with LATEST_FETCH_JOIN, for rows with `o.domain IS NULL`. */
export const CURRENT_PUBLISHED = `(lf.id IS NULL OR (
  (o.catalog_fetch_id = lf.id OR (o.catalog_fetch_id IS NULL AND o.observed_at > lf.fetched_at))
  AND EXISTS (SELECT 1 FROM provider_suffixes ps WHERE ps.provider_id = o.provider_id AND ps.suffix = o.suffix)
))`;
