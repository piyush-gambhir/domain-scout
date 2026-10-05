import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { Notice } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { EventsService } from '../events/events.service.js';
import { EvidenceReader } from '../evidence/evidence-reader.service.js';
import { Database, json } from '../storage/database.js';
import type { ObservationRow } from '../storage/evidence.js';
import { toNotice, type NoticeRow, type WatchRecord } from './watch-records.js';

type EvidenceRef = Notice['before'];
type NoticeType = Notice['type'];

/** Registry outcomes that answer "is there a registration record". Everything else never creates notices. */
const COMPARABLE_OUTCOMES = ['registered', 'no_record'];
/** Provider statuses for an exact name. `unknown` is unresolved and never compared. */
const COMPARABLE_CONFIRMATIONS = ['available', 'unavailable', 'restricted'];

/** Amount compared for each purchase path. */
const PATH_AMOUNT: Record<string, 'registration' | 'renewal' | 'transfer'> = {
  new_registration: 'registration',
  renewal: 'renewal',
  transfer: 'transfer',
  aftermarket: 'registration',
};

const CHUNK = 500;

interface OfferRowFull {
  id: string;
  provider_id: string;
  domain: string | null;
  suffix: string;
  purchase_path: string;
  kind: string;
  currency: string;
  region: string | null;
  term_years: number;
  promotional: number;
  registration: string | null;
  renewal: string | null;
  transfer: string | null;
  observed_at: string;
  payload_json: string;
}

/**
 * job_items columns written by the jobs engine (shared schema): the registry observation id, and
 * `evidence_json` = { observations?: string[]; offers?: string[]; reusedRegistry?: boolean }.
 */
interface JobItemEvidence {
  registry_observation_id: string | null;
  evidence_json: string;
}

/**
 * Compares the evidence a watch job produced with the previous comparable successful evidence for
 * the same subject, and records notices.
 *
 * Only these create notices: registry transitions between registered and no_record, provider
 * confirmation status changes among available/unavailable/restricted, and price changes between
 * offers with the same provider, scope, purchase path, kind, currency, region, term and promotion
 * flag where both amounts are known. Failures, timeouts, missing credentials, missing prices and
 * unresolved outcomes are skipped, so they can never produce a notice. Evidence from other jobs is
 * never the "after" side, and reused cached registry evidence is not new. Notices dedupe on
 * (watch, domain, type, before id, after id), so reprocessing a job adds nothing.
 *
 * Must run inside a Database.transaction: it writes notices and emits notice.created.
 */
@Injectable()
export class ChangeDetector {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly events: EventsService,
    private readonly reader: EvidenceReader,
  ) {}

  detect(watch: WatchRecord, jobId: string): Notice[] {
    const { observationIds, offerIds } = this.jobEvidence(jobId);
    const domains = new Set(watch.domains);
    const suffixes = new Set(watch.domains.map((d) => this.reader.normalize(d)?.suffix ?? d.slice(d.indexOf('.') + 1)));
    const observations = this.load<ObservationRow>('observations', observationIds);
    const offers = this.load<OfferRowFull>('offers', offerIds);
    const created: Notice[] = [];

    for (const row of observations) {
      if (!domains.has(row.subject)) continue;
      if (row.kind === 'registry' && watch.includeRegistry) {
        const notice = this.registryChange(watch, row, jobId);
        if (notice) created.push(notice);
      } else if (row.kind === 'confirmation') {
        const notice = this.confirmationChange(watch, row, jobId);
        if (notice) created.push(notice);
      }
    }
    for (const row of offers) {
      const exact = row.domain !== null && domains.has(row.domain);
      const catalog = row.domain === null && watch.includeCatalogPrices && suffixes.has(row.suffix);
      if (!exact && !catalog) continue;
      if (watch.providerIds.length && !watch.providerIds.includes(row.provider_id)) continue;
      const notice = this.offerChange(watch, row, jobId);
      if (notice) created.push(notice);
    }
    return created;
  }

  /** Evidence ids newly written by the job's items, in item order. */
  private jobEvidence(jobId: string): { observationIds: string[]; offerIds: string[] } {
    const observationIds: string[] = [];
    const offerIds: string[] = [];
    const rows = this.db.all<JobItemEvidence>(
      `SELECT registry_observation_id, evidence_json FROM job_items WHERE job_id = ? AND state = 'finished' ORDER BY seq`,
      [jobId],
    );
    for (const row of rows) {
      const refs = json.parse<{ observations?: string[]; offers?: string[]; reusedRegistry?: boolean }>(row.evidence_json, {});
      if (row.registry_observation_id && !refs.reusedRegistry) observationIds.push(row.registry_observation_id);
      observationIds.push(...(refs.observations ?? []));
      offerIds.push(...(refs.offers ?? []));
    }
    return { observationIds, offerIds };
  }

  private load<T extends { id: string; observed_at: string }>(table: 'observations' | 'offers', ids: string[]): T[] {
    const out: T[] = [];
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      out.push(...this.db.all<T>(`SELECT * FROM ${table} WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk));
    }
    // Chronological with the same binary id tie-break SQLite uses for predecessors.
    return out.sort((a, b) => (a.observed_at !== b.observed_at ? (a.observed_at < b.observed_at ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private registryChange(watch: WatchRecord, after: ObservationRow, jobId: string): Notice | null {
    if (!COMPARABLE_OUTCOMES.includes(after.outcome)) return null;
    const before = this.db.get<ObservationRow>(
      `SELECT * FROM observations WHERE kind = 'registry' AND subject = ? AND outcome IN ('registered', 'no_record')
         AND (observed_at < ? OR (observed_at = ? AND id < ?))
       ORDER BY observed_at DESC, id DESC LIMIT 1`,
      [after.subject, after.observed_at, after.observed_at, after.id],
    );
    if (!before || before.outcome === after.outcome) return null;
    return this.record(watch.id, after.subject, 'availability_changed', registryRef(before), registryRef(after), jobId,
      `${after.subject}: registry changed from ${outcomeLabel(before.outcome)} to ${outcomeLabel(after.outcome)}`);
  }

  private confirmationChange(watch: WatchRecord, after: ObservationRow, jobId: string): Notice | null {
    const payload = json.parse<{ providerId?: string; status?: string }>(after.payload_json, {});
    const providerId = payload.providerId;
    const status = payload.status ?? after.outcome;
    if (!providerId || !watch.providerIds.includes(providerId) || !COMPARABLE_CONFIRMATIONS.includes(status)) return null;
    const before = this.db.get<ObservationRow>(
      `SELECT * FROM observations WHERE kind = 'confirmation' AND subject = ?
         AND json_extract(payload_json, '$.providerId') = ?
         AND COALESCE(json_extract(payload_json, '$.status'), outcome) IN ('available', 'unavailable', 'restricted')
         AND (observed_at < ? OR (observed_at = ? AND id < ?))
       ORDER BY observed_at DESC, id DESC LIMIT 1`,
      [after.subject, providerId, after.observed_at, after.observed_at, after.id],
    );
    if (!before) return null;
    const beforeStatus = json.parse<{ status?: string }>(before.payload_json, {}).status ?? before.outcome;
    if (beforeStatus === status) return null;
    return this.record(watch.id, after.subject, 'confirmation_changed',
      confirmationRef(before, providerId, beforeStatus), confirmationRef(after, providerId, status), jobId,
      `${after.subject}: ${providerId} confirmation changed from ${beforeStatus} to ${status}`);
  }

  private offerChange(watch: WatchRecord, after: OfferRowFull, jobId: string): Notice | null {
    const column = PATH_AMOUNT[after.purchase_path] ?? 'registration';
    if (after[column] === null) return null;
    const scope = after.domain === null ? 'domain IS NULL AND suffix = ?' : 'domain = ?';
    const before = this.db.get<OfferRowFull>(
      `SELECT * FROM offers WHERE ${scope} AND provider_id = ? AND purchase_path = ? AND kind = ? AND currency = ?
         AND IFNULL(region, '') = ? AND term_years = ? AND promotional = ? AND ${column} IS NOT NULL
         AND (observed_at < ? OR (observed_at = ? AND id < ?))
       ORDER BY observed_at DESC, id DESC LIMIT 1`,
      [after.domain ?? after.suffix, after.provider_id, after.purchase_path, after.kind, after.currency, after.region ?? '',
        after.term_years, after.promotional, after.observed_at, after.observed_at, after.id],
    );
    if (!before || sameAmount(before[column]!, after[column]!)) return null;
    const label = after.domain ?? `.${after.suffix}`;
    const beforeRef = offerRef(before);
    const afterRef = offerRef(after);
    return this.record(watch.id, label, 'price_changed', beforeRef, afterRef, jobId,
      `${label}: ${after.provider_id} ${pathLabel(after)} price changed from ${beforeRef.value} to ${afterRef.value}`);
  }

  private record(
    watchId: string,
    domain: string,
    type: NoticeType,
    before: EvidenceRef,
    after: EvidenceRef,
    jobId: string,
    summary: string,
  ): Notice | null {
    const dedupeKey = [watchId, domain, type, before.id, after.id].join('|');
    const id = randomUUID();
    const { changes } = this.db.run(
      `INSERT INTO notices (id, watch_id, domain, type, summary, before_json, after_json, dedupe_key, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (dedupe_key) DO NOTHING`,
      [id, watchId, domain, type, summary, json.stringify(before), json.stringify(after), dedupeKey, this.clock.iso()],
    );
    if (changes === 0) return null;
    const notice = toNotice(this.db.get<NoticeRow>('SELECT * FROM notices WHERE id = ?', [id])!);
    this.events.emit('notice.created', { watchId, jobId }, notice);
    return notice;
  }
}

function registryRef(row: ObservationRow): EvidenceRef {
  const payload = json.parse<{ source?: { destination?: string } | null }>(row.payload_json, {});
  return {
    kind: 'registry',
    id: row.id,
    observedAt: row.observed_at,
    source: payload.source?.destination ?? row.destination ?? row.source_id ?? 'registry',
    value: row.outcome,
  };
}

function confirmationRef(row: ObservationRow, providerId: string, status: string): EvidenceRef {
  return { kind: 'confirmation', id: row.id, observedAt: row.observed_at, source: `provider:${providerId}`, value: status };
}

function offerRef(row: OfferRowFull): EvidenceRef {
  const payload = json.parse<{ source?: { label?: string } }>(row.payload_json, {});
  return {
    kind: 'offer',
    id: row.id,
    observedAt: row.observed_at,
    source: payload.source?.label ?? `provider:${row.provider_id}`,
    value: `${row[PATH_AMOUNT[row.purchase_path] ?? 'registration']} ${row.currency}`,
  };
}

function sameAmount(a: string, b: string): boolean {
  try {
    return new Decimal(a).eq(new Decimal(b));
  } catch {
    return a === b;
  }
}

function pathLabel(row: OfferRowFull): string {
  const parts = [row.purchase_path.replace(/_/g, ' '), row.kind.replace(/_/g, ' '), `${row.term_years}y`];
  if (row.region) parts.push(row.region);
  if (row.promotional) parts.push('promotional');
  return parts.join(', ');
}

function outcomeLabel(outcome: string): string {
  return outcome === 'no_record' ? 'no registry record' : outcome;
}
