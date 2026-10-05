import { Injectable } from '@nestjs/common';
import type { Offer, PurchasePath } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { decodeCursor, encodeCursor } from '../core/envelope.js';
import { Database } from '../storage/database.js';
import { hydrateOffer, type OfferRow } from '../storage/evidence.js';
import { ProvidersService } from '../providers/providers.service.js';
import { CURRENT_PUBLISHED, LATEST_FETCH_CTE, LATEST_FETCH_JOIN } from './current-catalog.js';

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

  /** Current published variants (one per currency and term) for a provider and suffix, newest first. */
  publishedVariants(providerId: string, suffix: string): PricedOffer[] {
    const rows = this.db.all<Row>(
      `WITH ${LATEST_FETCH_CTE},
       latest AS (
         SELECT o.*, o.rowid AS rid, ROW_NUMBER() OVER (PARTITION BY o.currency, o.term_years ORDER BY o.observed_at DESC, o.rowid DESC) AS rn
         FROM offers o ${LATEST_FETCH_JOIN}
         WHERE o.provider_id = ? AND o.suffix = ? AND o.domain IS NULL AND o.kind = 'published' AND o.purchase_path = 'new_registration'
           AND ${CURRENT_PUBLISHED}
       )
       SELECT * FROM latest WHERE rn = 1 ORDER BY observed_at DESC, rid DESC`,
      [providerId, suffix],
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
      filter = 'AND o.suffix = ?';
      params.push(suffix.toLowerCase().replace(/^\./, ''));
    }
    const base = `WITH ${LATEST_FETCH_CTE},
      latest AS (
        SELECT o.*, ROW_NUMBER() OVER (PARTITION BY o.suffix, o.currency, o.term_years ORDER BY o.observed_at DESC, o.rowid DESC) AS rn
        FROM offers o ${LATEST_FETCH_JOIN}
        WHERE o.provider_id = ? AND o.domain IS NULL AND o.kind = 'published' AND o.purchase_path = 'new_registration' ${filter}
          AND ${CURRENT_PUBLISHED}
      )`;
    const total = this.db.get<{ n: number }>(`${base} SELECT COUNT(*) AS n FROM latest l WHERE l.rn = 1`, params)?.n ?? 0;
    const rows = this.db.all<Row>(`${base} SELECT * FROM latest l WHERE l.rn = 1 ORDER BY l.suffix, l.currency, l.term_years LIMIT ? OFFSET ?`, [
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
