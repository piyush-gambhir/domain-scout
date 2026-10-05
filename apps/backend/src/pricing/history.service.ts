import { Injectable, Optional } from '@nestjs/common';
import type { PriceSeries, PurchasePath } from '@domain-scout/contracts';
import { decodeCursor, encodeCursor } from '../core/envelope.js';
import { InputPreviewer } from '../core/ports.js';
import { Database, json } from '../storage/database.js';
import { requireDomain } from './domain.js';
import { promotionSignature, type ComparablePayload } from './comparable.js';

interface HistoryRow {
  id: string;
  provider_id: string;
  domain: string | null;
  suffix: string;
  purchase_path: PurchasePath;
  kind: 'published' | 'estimated' | 'exact_quote';
  currency: string;
  region: string | null;
  term_years: number;
  promotional: number;
  registration: string | null;
  renewal: string | null;
  transfer: string | null;
  observed_at: string;
  stale_at: string;
  payload_json: string;
}

export interface HistoryQuery {
  domain?: string;
  suffix?: string;
  providerId?: string;
  since?: string;
  cursor?: string;
  limit: number;
}

type HistoryPayload = ComparablePayload;

/**
 * Observed price history. Observations are grouped into comparable series (same provider, scope,
 * purchase path, price kind, currency, region, registration term, renewal term, transfer-included
 * years and promotion conditions); unmatched records never join a trend. Gaps are periods no
 * observation's freshness window covered; nothing is interpolated.
 */
@Injectable()
export class HistoryService {
  constructor(
    private readonly db: Database,
    @Optional() private readonly previewer?: InputPreviewer,
  ) {}

  series(query: HistoryQuery): { items: PriceSeries[]; nextCursor: string | null; total: number } {
    const where: string[] = [];
    const params: string[] = [];
    if (query.domain) {
      const ref = requireDomain(query.domain, this.previewer ?? null);
      // Exact quotes for the domain plus suffix-level prices that apply to it.
      where.push('(domain = ? OR (domain IS NULL AND suffix = ?))');
      params.push(ref.ascii, ref.suffix);
    } else if (query.suffix) {
      where.push('domain IS NULL AND suffix = ?');
      params.push(query.suffix.toLowerCase().replace(/^\./, ''));
    }
    if (query.providerId) {
      where.push('provider_id = ?');
      params.push(query.providerId);
    }
    if (query.since) {
      where.push('observed_at >= ?');
      params.push(query.since);
    }
    const rows = this.db.all<HistoryRow>(
      `SELECT id, provider_id, domain, suffix, purchase_path, kind, currency, region, term_years, promotional,
              registration, renewal, transfer, observed_at, stale_at, payload_json
       FROM offers ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY observed_at, rowid`,
      params,
    );
    const groups = new Map<string, { series: PriceSeries; staleAts: string[] }>();
    for (const row of rows) {
      const scope = row.domain ?? row.suffix;
      const promotional = row.promotional === 1;
      // Renewal and transfer amounts are comparable only for the same covered years.
      const payload = json.parse<HistoryPayload>(row.payload_json, {});
      const renewalYears = payload.renewal?.years ?? 1;
      const transferYears = payload.transfer?.includesYears ?? null;
      const key = [
        row.provider_id,
        scope,
        row.purchase_path,
        // A published catalog price, an estimate and an exact quote are different measurements.
        row.kind,
        row.currency,
        row.region ?? '-',
        `${row.term_years}y`,
        `renew${renewalYears}y`,
        `transfer${transferYears ?? '?'}y`,
        promotionSignature(promotional, payload.promotion),
      ].join('|');
      let group = groups.get(key);
      if (!group) {
        group = {
          series: {
            key,
            providerId: row.provider_id,
            scope,
            purchasePath: row.purchase_path,
            currency: row.currency,
            region: row.region,
            termYears: row.term_years,
            promotional,
            kind: row.kind,
            promotion:
              promotional && payload.promotion
                ? {
                    description: payload.promotion.description ?? null,
                    requiresTermYears: payload.promotion.requiresTermYears ?? null,
                    expiresAt: payload.promotion.expiresAt ?? null,
                    restrictions: payload.promotion.restrictions ?? null,
                  }
                : null,
            points: [],
            gaps: [],
          },
          staleAts: [],
        };
        groups.set(key, group);
      }
      group.series.points.push({
        offerId: row.id,
        observedAt: row.observed_at,
        kind: row.kind,
        registration: row.registration,
        renewal: row.renewal,
        transfer: row.transfer,
      });
      group.staleAts.push(row.stale_at);
    }
    const all = [...groups.values()].map(({ series, staleAts }) => {
      for (let i = 1; i < series.points.length; i++) {
        const previousStale = staleAts[i - 1]!;
        const next = series.points[i]!.observedAt;
        if (Date.parse(next) > Date.parse(previousStale)) series.gaps.push({ from: previousStale, to: next });
      }
      return series;
    });
    all.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.scope.localeCompare(b.scope) || a.key.localeCompare(b.key));
    const offset = decodeCursor<{ o: number }>(query.cursor)?.o ?? 0;
    const items = all.slice(offset, offset + query.limit);
    const nextCursor = offset + items.length < all.length ? encodeCursor({ o: offset + items.length }) : null;
    return { items, nextCursor, total: all.length };
  }
}
