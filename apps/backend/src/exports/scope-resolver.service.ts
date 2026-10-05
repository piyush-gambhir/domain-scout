import { Injectable, Optional } from '@nestjs/common';
import {
  ResultFilter,
  type AftermarketListing,
  type BestPrice,
  type Diagnostic,
  type ExportScope,
  type JobItem,
  type NameCheck,
  type Offer,
  type ProviderConfirmation,
  type RegistryObservation,
  type ResultFilterParsed,
} from '@domain-scout/contracts';
import type { z } from 'zod';
import { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { JobResults } from '../core/ports.js';
import { EvidenceReader } from '../evidence/evidence-reader.service.js';
import { Database } from '../storage/database.js';
import { hydrateObservation, type ObservationRow } from '../storage/evidence.js';

/** Largest page JobResults.list returns. */
const FILTER_PAGE = 1000;

/** Name-check, diagnostic or listing evidence carried by a job item, flattened for artifacts. */
export interface OtherEvidence {
  kind: 'name_check' | 'diagnostic' | 'listing';
  id: string;
  label: string;
  outcome: string;
  checkedAt: string;
  freshness: string | null;
  source: string | null;
  reason: string | null;
}

/** One exported or snapshotted row: a job item, or a domain with its latest evidence. */
export interface ScopedRecord {
  itemId: string | null;
  domain: string;
  unicode: string;
  suffix: string;
  registry: RegistryObservation | null;
  confirmations: ProviderConfirmation[];
  offers: Offer[];
  other: OtherEvidence[];
  bestPrice: z.infer<typeof BestPrice> | null;
  /** Operation-specific outcome of a job item when it carries no registry evidence. */
  itemOutcome: string | null;
  operation: string | null;
  target: string | null;
  /** Error message of an unresolved job item that produced no evidence. */
  itemError: string | null;
  notes: string | null;
}

/** Stable ids an artifact was built from, stored with it so later job changes cannot alter its meaning. */
export interface ResolvedScope {
  kind: ExportScope['kind'];
  itemIds: string[] | null;
  domains: string[];
  evidenceIds: { registry: string[]; confirmations: string[]; offers: string[]; other: string[] };
}

export interface Resolution {
  records: ScopedRecord[];
  resolved: ResolvedScope;
  warnings: string[];
  /** Human description of the scope for artifact headers. */
  label: string;
}

@Injectable()
export class ScopeResolver {
  constructor(
    private readonly db: Database,
    private readonly reader: EvidenceReader,
    private readonly clock: Clock,
    @Optional() private readonly results?: JobResults,
  ) {}

  resolve(scope: ExportScope): Resolution {
    const warnings: string[] = [];
    let records: ScopedRecord[];
    let label: string;
    let itemIds: string[] | null = null;
    switch (scope.kind) {
      case 'selection': {
        const items = this.jobResults().byIds(scope.itemIds);
        if (items.length < new Set(scope.itemIds).size) {
          warnings.push(`${new Set(scope.itemIds).size - items.length} selected items no longer exist and were skipped`);
        }
        records = items.map((item) => this.fromItem(item));
        itemIds = items.map((item) => item.id);
        label = `${items.length} selected results`;
        break;
      }
      case 'filter': {
        // The same pages the results view shows, so prices use the filter's priceCurrency.
        const items = this.filteredItems(scope.jobId, ResultFilter.parse(scope.filter));
        records = items.map((item) => this.fromItem(item));
        itemIds = items.map((item) => item.id);
        label = `filtered results of job ${scope.jobId}`;
        break;
      }
      case 'job': {
        const ids = this.jobResults().matchingIds(scope.jobId, ResultFilter.parse({}));
        const items = this.jobResults().byIds(ids);
        records = items.map((item) => this.fromItem(item));
        itemIds = items.map((item) => item.id);
        label = `all results of job ${scope.jobId}`;
        break;
      }
      case 'collection': {
        const collection = this.db.get<{ name: string }>('SELECT name FROM collections WHERE id = ?', [scope.collectionId]);
        if (!collection) throw AppError.notFound('Collection');
        const entries = this.db.all<{ domain: string; unicode: string; notes: string | null }>(
          'SELECT domain, unicode, notes FROM collection_entries WHERE collection_id = ? ORDER BY added_at, domain',
          [scope.collectionId],
        );
        records = entries.map((entry) => this.fromDomain(entry.domain, entry.unicode, entry.notes));
        label = `collection ${collection.name}`;
        break;
      }
      case 'domains': {
        const seen = new Set<string>();
        records = [];
        for (const input of scope.domains) {
          const normalized = this.reader.normalize(input);
          if (!normalized) {
            warnings.push(`Skipped invalid domain: ${input.slice(0, 100)}`);
            continue;
          }
          if (seen.has(normalized.ascii)) continue;
          seen.add(normalized.ascii);
          records.push(this.fromDomain(normalized.ascii, normalized.unicode, undefined, normalized.suffix));
        }
        label = `${records.length} listed domains`;
        break;
      }
      case 'all': {
        records = this.reader.observedDomains().map((domain) => this.fromDomain(domain));
        label = 'every observed domain';
        break;
      }
    }
    return {
      records,
      warnings,
      label,
      resolved: {
        kind: scope.kind,
        itemIds,
        domains: [...new Set(records.map((r) => r.domain))],
        evidenceIds: {
          registry: unique(records.flatMap((r) => (r.registry ? [r.registry.id] : []))),
          confirmations: unique(records.flatMap((r) => r.confirmations.map((c) => c.id))),
          offers: unique(records.flatMap((r) => r.offers.map((o) => o.id))),
          other: unique(records.flatMap((r) => r.other.map((o) => o.id))),
        },
      },
    };
  }

  /** Private notes for a domain outside a collection scope: every shortlist note, joined. */
  notesFor(domain: string): string | null {
    const notes = this.db
      .all<{ notes: string | null }>('SELECT notes FROM collection_entries WHERE domain = ? AND notes IS NOT NULL ORDER BY added_at', [domain])
      .map((r) => r.notes!)
      .filter((n) => n.trim() !== '');
    return notes.length ? notes.join(' | ') : null;
  }

  /** Every item matching the filter, in result order, hydrated exactly as the results view does. */
  private filteredItems(jobId: string, filter: ResultFilterParsed): JobItem[] {
    const items: JobItem[] = [];
    let cursor: string | null = null;
    do {
      const page = this.jobResults().list(jobId, filter, cursor, FILTER_PAGE);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  /**
   * Newest name check per service and namespace for the domain's label, newest diagnostic per check
   * and newest listing per marketplace, the same kinds a job item would carry.
   */
  private latestOther(domain: string, unicode: string, suffix: string): OtherEvidence[] {
    const label = suffix && domain.endsWith(`.${suffix}`) ? domain.slice(0, -(suffix.length + 1)) : domain.split('.')[0]!;
    // Name-check subjects keep the case they were submitted with; match the A-label and Unicode label.
    const labels = [...new Set([label, unicode.split('.')[0] ?? label].map((l) => l.toLowerCase()).filter(Boolean))];
    const now = this.clock.now();
    return [
      ...this.newestPer('name_check', `lower(subject) IN (${labels.map(() => '?').join(', ')})`, labels, ['service', 'namespace']).map((row) =>
        nameCheckEvidence(hydrateObservation<NameCheck>(row, now)),
      ),
      ...this.newestPer('diagnostic', 'subject = ?', [domain], ['check']).map((row) => diagnosticEvidence(hydrateObservation<Diagnostic>(row, now))),
      ...this.newestPer('listing', 'subject = ?', [domain], ['marketplace']).map((row) => listingEvidence(hydrateObservation<AftermarketListing>(row, now))),
    ];
  }

  /**
   * Newest observation per payload key (newest first), chosen in SQL before any limit so a long
   * history of one service or check never hides another. `where` and `keys` are fixed fragments.
   */
  private newestPer(kind: 'name_check' | 'diagnostic' | 'listing', where: string, params: string[], keys: string[]): ObservationRow[] {
    const partition = keys.map((key) => `json_extract(payload_json, '$.${key}')`).join(', ');
    return this.db.all<ObservationRow>(
      `SELECT * FROM (
         SELECT o.*, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY observed_at DESC, id DESC) AS rn
         FROM observations o WHERE kind = ? AND ${where}
       ) WHERE rn = 1 ORDER BY observed_at DESC, id DESC`,
      [kind, ...params],
    );
  }

  private jobResults(): JobResults {
    if (!this.results) throw new AppError('unavailable', 'Job results are not available');
    return this.results;
  }

  private fromItem(item: JobItem): ScopedRecord {
    const suffix = item.suffix ?? this.reader.normalize(item.subject)?.suffix ?? '';
    return {
      itemId: item.id,
      domain: item.subject,
      unicode: item.unicode,
      suffix,
      registry: item.evidence?.registry ?? null,
      confirmations: item.evidence?.confirmation ? [item.evidence.confirmation] : [],
      offers: item.evidence?.offers ?? [],
      other: otherEvidence(item),
      bestPrice: item.bestPrice ?? null,
      itemOutcome: item.outcome,
      operation: item.operation,
      target: item.target,
      itemError: item.error?.message ?? null,
      notes: null,
    };
  }

  private fromDomain(domain: string, unicode?: string, notes?: string | null, suffixHint?: string): ScopedRecord {
    const normalized = suffixHint ? null : this.reader.normalize(domain);
    const suffix = suffixHint ?? normalized?.suffix ?? domain.slice(domain.indexOf('.') + 1);
    const latest = this.reader.latest(domain, suffix);
    const shownUnicode = unicode ?? normalized?.unicode ?? latest.registry?.unicode ?? domain;
    return {
      itemId: null,
      domain,
      unicode: shownUnicode,
      suffix,
      registry: latest.registry,
      confirmations: latest.confirmations,
      offers: latest.offers,
      other: this.latestOther(domain, shownUnicode, suffix),
      bestPrice: null,
      itemOutcome: null,
      operation: null,
      target: null,
      itemError: null,
      notes: notes === undefined ? null : notes,
    };
  }
}

function otherEvidence(item: JobItem): OtherEvidence[] {
  const out: OtherEvidence[] = [];
  if (item.evidence?.nameCheck) out.push(nameCheckEvidence(item.evidence.nameCheck));
  if (item.evidence?.diagnostic) out.push(diagnosticEvidence(item.evidence.diagnostic));
  if (item.evidence?.listing) out.push(listingEvidence(item.evidence.listing));
  return out;
}

function nameCheckEvidence(check: NameCheck): OtherEvidence {
  return {
    kind: 'name_check',
    id: check.id,
    label: `${check.service} (${check.namespace})`,
    outcome: check.outcome,
    checkedAt: check.checkedAt,
    freshness: check.freshness ?? null,
    source: check.destination,
    reason: check.reason?.message ?? null,
  };
}

function diagnosticEvidence(diagnostic: Diagnostic): OtherEvidence {
  return {
    kind: 'diagnostic',
    id: diagnostic.id,
    label: `${diagnostic.check} diagnostic`,
    outcome: diagnostic.outcome,
    checkedAt: diagnostic.checkedAt,
    freshness: diagnostic.freshness ?? null,
    source: diagnostic.destination,
    reason: diagnostic.reason?.message ?? null,
  };
}

function listingEvidence(listing: AftermarketListing): OtherEvidence {
  return {
    kind: 'listing',
    id: listing.id,
    label: `listing on ${listing.marketplace}`,
    outcome: listing.status,
    checkedAt: listing.observedAt,
    freshness: listing.freshness ?? null,
    source: listing.source,
    reason: listing.caveat,
  };
}


function unique(values: string[]): string[] {
  return [...new Set(values)];
}
