











export const LATEST_FETCH_CTE = `latest_fetch AS (
  SELECT provider_id, id, fetched_at FROM (
    SELECT provider_id, id, fetched_at,
           ROW_NUMBER() OVER (PARTITION BY provider_id ORDER BY fetched_at DESC, rowid DESC) AS fetch_rn
    FROM catalog_fetches WHERE status = 'ok'
  ) WHERE fetch_rn = 1
)`;


export const LATEST_FETCH_JOIN = 'LEFT JOIN latest_fetch lf ON lf.provider_id = o.provider_id';


export const CURRENT_PUBLISHED = `(lf.id IS NULL OR (
  (o.catalog_fetch_id = lf.id OR (o.catalog_fetch_id IS NULL AND o.observed_at > lf.fetched_at))
  AND EXISTS (SELECT 1 FROM provider_suffixes ps WHERE ps.provider_id = o.provider_id AND ps.suffix = o.suffix)
))`;
