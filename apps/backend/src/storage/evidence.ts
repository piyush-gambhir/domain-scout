import { Injectable } from '@nestjs/common';
import type { Freshness } from '@domain-scout/contracts';
import { Database, json } from './database.js';

export type ObservationKind = 'registry' | 'confirmation' | 'name_check' | 'diagnostic' | 'listing';

/** Immutable evidence row. `payload` is the contract object without computed fields (freshness, reused). */
export interface ObservationWrite {
  id: string;
  kind: ObservationKind;
  subject: string;
  suffix: string | null;
  sourceId: string | null;
  destination: string | null;
  outcome: string;
  observedAt: string;
  staleAt: string;
  payload: Record<string, unknown>;
  /** Sanitized raw response, stored only when settings.privacy.keepRawDiagnostics is on. */
  raw?: { contentType: string | null; body: string; truncated: boolean } | null;
}

/** Append-only price row. `payload` is the contract Offer without computed fields (freshness). */
export interface OfferWrite {
  id: string;
  providerId: string;
  domain: string | null;
  suffix: string;
  purchasePath: string;
  kind: 'published' | 'estimated' | 'exact_quote';
  currency: string;
  region: string | null;
  termYears: number;
  promotional: boolean;
  registration: string | null;
  renewal: string | null;
  transfer: string | null;
  observedAt: string;
  staleAt: string;
  quoteExpiresAt: string | null;
  catalogFetchId: string | null;
  payload: Record<string, unknown>;
}

export interface ObservationRow {
  id: string;
  kind: ObservationKind;
  subject: string;
  suffix: string | null;
  source_id: string | null;
  destination: string | null;
  outcome: string;
  observed_at: string;
  stale_at: string;
  payload_json: string;
}

export interface OfferRow {
  id: string;
  provider_id: string;
  domain: string | null;
  suffix: string;
  purchase_path: string;
  kind: string;
  currency: string;
  quote_expires_at: string | null;
  observed_at: string;
  stale_at: string;
  payload_json: string;
}

/** Freshness relative to `now`: expired beats stale when a provider gave an explicit quote expiry. */
export function freshnessOf(staleAt: string, now: Date, expiresAt?: string | null): Freshness {
  const t = now.getTime();
  if (expiresAt && Date.parse(expiresAt) <= t) return 'expired';
  return Date.parse(staleAt) <= t ? 'stale' : 'fresh';
}

/** Contract object for an observation row, with freshness computed at read time. */
export function hydrateObservation<T>(row: ObservationRow, now: Date, extra: Record<string, unknown> = {}): T {
  const payload = json.parse<Record<string, unknown>>(row.payload_json, {});
  return { ...payload, freshness: freshnessOf(row.stale_at, now), ...extra } as T;
}

/** Contract Offer for an offer row, with freshness computed at read time. */
export function hydrateOffer<T>(row: OfferRow, now: Date): T {
  const payload = json.parse<Record<string, unknown>>(row.payload_json, {});
  return { ...payload, freshness: freshnessOf(row.stale_at, now, row.quote_expires_at) } as T;
}

/** Shared evidence store used by the jobs engine and every module that records sourced facts. */
@Injectable()
export class EvidenceRepository {
  constructor(private readonly db: Database) {}

  insertObservation(o: ObservationWrite) {
    this.db.run(
      `INSERT INTO observations (id, kind, subject, suffix, source_id, destination, outcome, observed_at, stale_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [o.id, o.kind, o.subject, o.suffix, o.sourceId, o.destination, o.outcome, o.observedAt, o.staleAt, json.stringify(o.payload)],
    );
    if (o.raw) {
      this.db.run(
        'INSERT INTO raw_diagnostics (observation_id, content_type, body, truncated, created_at) VALUES (?, ?, ?, ?, ?)',
        [o.id, o.raw.contentType, o.raw.body, o.raw.truncated ? 1 : 0, o.observedAt],
      );
    }
  }

  insertOffer(o: OfferWrite) {
    this.db.run(
      `INSERT INTO offers (id, provider_id, domain, suffix, purchase_path, kind, currency, region, term_years, promotional,
         registration, renewal, transfer, observed_at, stale_at, quote_expires_at, catalog_fetch_id, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        o.id,
        o.providerId,
        o.domain,
        o.suffix,
        o.purchasePath,
        o.kind,
        o.currency,
        o.region,
        o.termYears,
        o.promotional ? 1 : 0,
        o.registration,
        o.renewal,
        o.transfer,
        o.observedAt,
        o.staleAt,
        o.quoteExpiresAt,
        o.catalogFetchId,
        json.stringify(o.payload),
      ],
    );
  }

  observation(id: string): ObservationRow | undefined {
    return this.db.get<ObservationRow>('SELECT * FROM observations WHERE id = ?', [id]);
  }

  latestObservation(kind: ObservationKind, subject: string): ObservationRow | undefined {
    return this.db.get<ObservationRow>(
      'SELECT * FROM observations WHERE kind = ? AND subject = ? ORDER BY observed_at DESC LIMIT 1',
      [kind, subject],
    );
  }

  observations(kind: ObservationKind, subject: string, limit = 50): ObservationRow[] {
    return this.db.all<ObservationRow>(
      'SELECT * FROM observations WHERE kind = ? AND subject = ? ORDER BY observed_at DESC LIMIT ?',
      [kind, subject, limit],
    );
  }

  offer(id: string): OfferRow | undefined {
    return this.db.get<OfferRow>('SELECT * FROM offers WHERE id = ?', [id]);
  }
}
