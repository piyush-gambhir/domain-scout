import { Injectable } from '@nestjs/common';
import type {
  AftermarketListing,
  Diagnostic,
  JobItem,
  NameCheck,
  Offer,
  ProviderConfirmation,
  RegistryObservation,
  ResultFilterParsed,
} from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { decodeCursor, encodeCursor } from '../core/envelope.js';
import { JobResults } from '../core/ports.js';
import { Database, json } from '../storage/database.js';
import { hydrateObservation, hydrateOffer, type ObservationRow, type OfferRow } from '../storage/evidence.js';
import { SettingsService } from '../system/settings.service.js';
import { JobStore, type ItemEvidenceRefs, type ItemRow } from './job-store.js';
import { ResultQueryBuilder, type ResultKey } from './results.query.js';

const CHUNK = 500;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

interface BestPriceRow {
  suffix: string;
  currency: string;
  provider_id: string;
  amount: string;
  years: number;
  kind: 'published' | 'estimated' | 'exact_quote';
}

interface CursorShape {
  s: string;
  o: string;
  k: ResultKey;
}

function chunks<T>(values: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += CHUNK) out.push(values.slice(i, i + CHUNK));
  return out;
}

function marks(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

/** Results for job views, CLI queries and exports: one filter/sort implementation and JobItem assembly. */
@Injectable()
export class JobResultsService implements JobResults {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly store: JobStore,
  ) {}

  list(
    jobId: string,
    filter: ResultFilterParsed,
    cursor?: string | null,
    limit: number = DEFAULT_LIMIT,
  ): { items: JobItem[]; nextCursor: string | null; total: number } {
    this.store.requireJobRow(jobId);
    const size = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit) || DEFAULT_LIMIT));
    const builder = this.builder(jobId, filter);
    const after = this.decode(cursor, filter, builder.keyLength());
    const page = builder.page(after, size + 1);
    const rows = this.db.all<ItemRow & Record<string, unknown>>(page.sql, page.params);
    const more = rows.length > size;
    const pageRows = more ? rows.slice(0, size) : rows;
    const last = pageRows[pageRows.length - 1];
    const count = builder.count();
    const total = this.db.get<{ n: number }>(count.sql, count.params)?.n ?? 0;
    let nextCursor: string | null = null;
    if (more && last) {
      const key = Array.from({ length: builder.keyLength() }, (_, n) => last[`_k${n}`] as ResultKey[number]);
      nextCursor = encodeCursor({ s: filter.sort, o: filter.order, k: key } satisfies CursorShape);
    }
    return { items: this.hydrate(pageRows, this.priceCurrency(filter)), nextCursor, total };
  }

  matchingIds(jobId: string, filter: ResultFilterParsed): string[] {
    this.store.requireJobRow(jobId);
    const query = this.builder(jobId, filter).ids();
    return this.db.all<{ id: string }>(query.sql, query.params).map((r) => r.id);
  }

  byIds(itemIds: string[]): JobItem[] {
    const ids = [...new Set(itemIds)];
    const rows = new Map<string, ItemRow>();
    for (const chunk of chunks(ids)) {
      for (const row of this.db.all<ItemRow>(`SELECT * FROM job_items WHERE id IN (${marks(chunk)})`, chunk)) rows.set(row.id, row);
    }
    const ordered = itemIds.map((id) => rows.get(id)).filter((r): r is ItemRow => r !== undefined);
    return this.hydrate(ordered);
  }

  /**
   * Assembles contract JobItems with batched evidence, best price and collection lookups. bestPrice
   * uses `currency` (the filter's priceCurrency for result lists), else the comparison currency.
   */
  hydrate(rows: ItemRow[], currency: string = this.priceCurrency()): JobItem[] {
    if (rows.length === 0) return [];
    const now = this.clock.now();
    const refs = rows.map((r) => json.parse<ItemEvidenceRefs>(r.evidence_json, {}));

    const observationIds = new Set<string>();
    const offerIds = new Set<string>();
    rows.forEach((row, n) => {
      if (row.registry_observation_id) observationIds.add(row.registry_observation_id);
      for (const id of refs[n]!.observations ?? []) observationIds.add(id);
      for (const id of refs[n]!.offers ?? []) offerIds.add(id);
    });
    const observations = new Map<string, ObservationRow>();
    for (const chunk of chunks([...observationIds])) {
      for (const row of this.db.all<ObservationRow>(`SELECT * FROM observations WHERE id IN (${marks(chunk)})`, chunk)) {
        observations.set(row.id, row);
      }
    }
    const offers = new Map<string, OfferRow>();
    for (const chunk of chunks([...offerIds])) {
      for (const row of this.db.all<OfferRow>(`SELECT * FROM offers WHERE id IN (${marks(chunk)})`, chunk)) offers.set(row.id, row);
    }

    const best = new Map<string, BestPriceRow>();
    const suffixes = [...new Set(rows.map((r) => r.suffix).filter((s): s is string => s !== null))];
    for (const chunk of chunks(suffixes)) {
      for (const row of this.db.all<BestPriceRow>(
        `SELECT * FROM best_prices WHERE currency = ? AND suffix IN (${marks(chunk)})`,
        [currency, ...chunk],
      )) {
        best.set(row.suffix, row);
      }
    }

    const collections = new Map<string, string[]>();
    const subjects = [...new Set(rows.map((r) => r.subject))];
    for (const chunk of chunks(subjects)) {
      for (const row of this.db.all<{ collection_id: string; domain: string }>(
        `SELECT collection_id, domain FROM collection_entries WHERE domain IN (${marks(chunk)}) ORDER BY added_at, collection_id`,
        chunk,
      )) {
        const list = collections.get(row.domain) ?? [];
        list.push(row.collection_id);
        collections.set(row.domain, list);
      }
    }

    return rows.map((row, n): JobItem => {
      const ref = refs[n]!;
      const registryRow = row.registry_observation_id ? observations.get(row.registry_observation_id) : undefined;
      const evidence: JobItem['evidence'] = {
        registry: registryRow
          ? hydrateObservation<RegistryObservation>(registryRow, now, { reused: ref.reusedRegistry === true })
          : null,
        confirmation: null,
        offers: [],
        nameCheck: null,
        diagnostic: null,
        listing: null,
      };
      for (const id of ref.observations ?? []) {
        const obs = observations.get(id);
        if (!obs) continue;
        if (obs.kind === 'confirmation' && !evidence.confirmation) {
          evidence.confirmation = hydrateObservation<ProviderConfirmation>(obs, now);
        } else if (obs.kind === 'name_check' && !evidence.nameCheck) {
          evidence.nameCheck = hydrateObservation<NameCheck>(obs, now);
        } else if (obs.kind === 'diagnostic' && !evidence.diagnostic) {
          evidence.diagnostic = hydrateObservation<Diagnostic>(obs, now);
        } else if (obs.kind === 'listing' && !evidence.listing) {
          evidence.listing = hydrateObservation<AftermarketListing>(obs, now);
        } else if (obs.kind === 'registry' && !evidence.registry) {
          evidence.registry = hydrateObservation<RegistryObservation>(obs, now, { reused: ref.reusedRegistry === true });
        }
      }
      for (const id of ref.offers ?? []) {
        const offer = offers.get(id);
        if (offer) evidence.offers.push(hydrateOffer<Offer>(offer, now));
      }
      const price = row.suffix ? best.get(row.suffix) : undefined;
      return {
        id: row.id,
        jobId: row.job_id,
        subject: row.subject,
        unicode: row.unicode,
        suffix: row.suffix,
        operation: row.operation,
        target: row.target === '' ? null : row.target,
        source: row.source_key ? row.source_key : null,
        state: row.state,
        attempts: row.attempts,
        outcome: row.outcome,
        resolved: row.resolved === 1,
        error: json.parse<JobItem['error']>(row.error_json, null),
        retryAt: row.retry_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        evidence,
        bestPrice: price
          ? { providerId: price.provider_id, amount: price.amount, currency: price.currency, kind: price.kind, years: price.years }
          : null,
        collectionIds: collections.get(row.subject) ?? [],
      };
    });
  }

  private priceCurrency(filter?: ResultFilterParsed): string {
    return filter?.priceCurrency ?? this.settings.get().comparison.currency ?? 'USD';
  }

  private builder(jobId: string, filter: ResultFilterParsed): ResultQueryBuilder {
    return new ResultQueryBuilder(
      jobId,
      { ...filter, sort: filter.sort ?? 'input', order: filter.order ?? 'asc' },
      this.priceCurrency(filter),
    );
  }

  private decode(cursor: string | null | undefined, filter: ResultFilterParsed, length: number): ResultKey | null {
    if (!cursor) return null;
    const value = decodeCursor<CursorShape>(cursor);
    const valid =
      value &&
      value.s === (filter.sort ?? 'input') &&
      value.o === (filter.order ?? 'asc') &&
      Array.isArray(value.k) &&
      value.k.length === length &&
      value.k.every((k) => typeof k === 'string' || typeof k === 'number');
    if (!valid) throw AppError.invalid('Invalid or mismatched cursor for this sort order');
    return value.k;
  }
}
