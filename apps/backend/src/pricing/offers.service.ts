import { Injectable } from '@nestjs/common';
import type { Offer, PurchasePath } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { decodeCursor, encodeCursor } from '../core/envelope.js';
import { Database } from '../storage/database.js';
import { hydrateOffer, type OfferRow } from '../storage/evidence.js';
import { ProvidersService } from '../providers/providers.service.js';

export interface PricedOffer {
  offer: Offer;
  /** The registration amount includes a promotion (offers.promotional). */
  promotional: boolean;
  staleAt: string;
}

type Row = OfferRow & { promotional: number };

/** Read side for offers: latest catalog prices per provider and suffix, and exact quotes per domain. */
@Injectable()
export class OffersService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly providers: ProvidersService,
  ) {}

  private priced(row: Row): PricedOffer {
    return { offer: hydrateOffer<Offer>(row, this.clock.now()), promotional: row.promotional === 1, staleAt: row.stale_at };
  }

  /** A provider whose latest successful catalog omits the suffix no longer publishes a price for it. */
  private listedByCatalog(providerId: string, suffix: string): boolean {
    if (!this.providers.latestOkFetch(providerId)) return true;
    return Boolean(this.db.get('SELECT 1 AS x FROM provider_suffixes WHERE provider_id = ? AND suffix = ?', [providerId, suffix]));
  }

  /**
   * SQL condition (alias `o`, one bound parameter pair: fetch id, fetched_at) selecting published
   * rows that are current for a provider: the latest successful catalog's rows, plus suffix-level
   * prices recorded after it (e.g. alongside a quote). Without a successful catalog every row counts.
   * A failed refresh adds no fetch, so the previous values stay and age into stale.
   */
  private currentPublished(providerId: string): { sql: string; params: string[] } {
    const fetch = this.providers.latestOkFetch(providerId);
    if (!fetch) return { sql: '1 = 1', params: [] };
    return { sql: '(o.catalog_fetch_id = ? OR (o.catalog_fetch_id IS NULL AND o.observed_at > ?))', params: [fetch.id, fetch.fetched_at] };
  }

  /** Current published variants (one per currency and term) for a provider and suffix, newest first. */
  publishedVariants(providerId: string, suffix: string): PricedOffer[] {
    if (!this.listedByCatalog(providerId, suffix)) return [];
    const current = this.currentPublished(providerId);
    const rows = this.db.all<Row>(
      `WITH latest AS (
         SELECT o.*, o.rowid AS rid, ROW_NUMBER() OVER (PARTITION BY o.currency, o.term_years ORDER BY o.observed_at DESC, o.rowid DESC) AS rn
         FROM offers o
         WHERE o.provider_id = ? AND o.suffix = ? AND o.domain IS NULL AND o.kind = 'published' AND o.purchase_path = 'new_registration'
           AND ${current.sql}
       )
       SELECT * FROM latest WHERE rn = 1 ORDER BY observed_at DESC, rid DESC`,
      [providerId, suffix, ...current.params],
    );
    return rows.map((r) => this.priced(r));
  }

  /**
   * The published price used for one provider: a variant in the requested currency when there is
   * one, preferring a one-year term, else the newest variant.
   */
  latestPublished(providerId: string, suffix: string, currency?: string | null): PricedOffer | null {
    const variants = this.publishedVariants(providerId, suffix);
    const inCurrency = currency ? variants.filter((v) => v.offer.currency === currency) : variants;
    const pool = inCurrency.length ? inCurrency : variants;
    return pool.find((v) => v.offer.registration.years === 1) ?? pool[0] ?? null;
  }

  /** Latest exact quote from a provider for a domain and purchase path. */
  latestQuote(providerId: string, domain: string, path: PurchasePath): PricedOffer | null {
    const row = this.db.get<Row>(
      `SELECT * FROM offers WHERE provider_id = ? AND domain = ? AND purchase_path = ? AND kind = 'exact_quote'
       ORDER BY observed_at DESC, rowid DESC LIMIT 1`,
      [providerId, domain, path],
    );
    return row ? this.priced(row) : null;
  }

  /** Latest published prices of one provider, one row per suffix, ordered by suffix. */
  providerCatalog(providerId: string, suffix: string | null, cursor: string | null, limit: number) {
    const offset = decodeCursor<{ o: number }>(cursor)?.o ?? 0;
    const params: (string | number)[] = [providerId];
    let filter = '';
    if (suffix) {
      filter = 'AND suffix = ?';
      params.push(suffix.toLowerCase().replace(/^\./, ''));
    }
    const current = this.currentPublished(providerId);
    const listed = this.providers.latestOkFetch(providerId)
      ? 'AND EXISTS (SELECT 1 FROM provider_suffixes s WHERE s.provider_id = l.provider_id AND s.suffix = l.suffix)'
      : '';
    params.push(...current.params);
    const base = `WITH latest AS (
        SELECT o.*, ROW_NUMBER() OVER (PARTITION BY o.suffix, o.currency, o.term_years ORDER BY o.observed_at DESC, o.rowid DESC) AS rn
        FROM offers o
        WHERE o.provider_id = ? AND o.domain IS NULL AND o.kind = 'published' AND o.purchase_path = 'new_registration' ${filter}
          AND ${current.sql}
      )`;
    const total = this.db.get<{ n: number }>(`${base} SELECT COUNT(*) AS n FROM latest l WHERE l.rn = 1 ${listed}`, params)?.n ?? 0;
    const rows = this.db.all<Row>(`${base} SELECT * FROM latest l WHERE l.rn = 1 ${listed} ORDER BY l.suffix, l.currency, l.term_years LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    const items = rows.map((r) => this.priced(r).offer);
    const nextCursor = offset + items.length < total ? encodeCursor({ o: offset + items.length }) : null;
    return { items, nextCursor, total };
  }

  /**
   * Offers relevant to one domain: each provider's latest published price for its suffix (with the
   * destination filled for this domain from the same provider) and the latest exact quote per
   * provider and purchase path.
   */
  domainOffers(domain: string, suffix: string): Offer[] {
    const out: Offer[] = [];
    for (const manifest of this.providers.manifests()) {
      if (manifest.kind !== 'registrar') continue;
      const link = this.providers.destination(manifest.id, domain, 'new_registration');
      for (const published of this.publishedVariants(manifest.id, suffix)) {
        out.push({ ...published.offer, destination: link ? { url: link.url, kind: link.kind } : null });
      }
    }
    const quotes = this.db.all<Row>(
      `WITH latest AS (
         SELECT o.*, ROW_NUMBER() OVER (PARTITION BY o.provider_id, o.purchase_path ORDER BY o.observed_at DESC, o.rowid DESC) AS rn
         FROM offers o WHERE o.domain = ? AND o.kind = 'exact_quote'
       )
       SELECT * FROM latest WHERE rn = 1 ORDER BY provider_id, purchase_path`,
      [domain],
    );
    for (const row of quotes) out.push(this.priced(row).offer);
    return out;
  }
}
