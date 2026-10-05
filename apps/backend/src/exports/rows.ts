import { Decimal } from 'decimal.js';
import type { ExportField, Offer } from '@domain-scout/contracts';
import type { ScopedRecord } from './scope-resolver.service.js';

/** Shown in every artifact so names are never presented as guaranteed registrable. */
export const UNCERTAINTY_NOTICE = [
  'These are candidates, not a list of guaranteed registrable names.',
  '"no_record" means the registry returned no registration record when checked. It does not confirm eligibility, price or that the name can still be registered.',
  'Provider confirmations and prices are separate observations with their own times. Unknown prices are blank, never zero.',
  'Check again before purchase.',
];

/** Fields structured exports always carry so statuses, source, check time and price type survive. */
export const REQUIRED_STRUCTURED_FIELDS: readonly ExportField[] = ['domain', 'outcome', 'checkedAt', 'source', 'priceKind'];

const KIND_RANK: Record<string, number> = { exact_quote: 0, published: 1, estimated: 2 };

export interface PriceSummary {
  providerId: string;
  kind: string;
  registration: string | null;
  renewal: string | null;
  currency: string;
  observedAt: string | null;
}

/**
 * The price shown on a row: a new-registration offer with a known first-year amount, preferring
 * exact quotes over published and estimated prices, then the lowest amount within a currency.
 * Falls back to the job item's best published price. Null when no price is known.
 */
export function pickPrice(record: ScopedRecord): PriceSummary | null {
  const candidates = record.offers.filter(
    (offer) => offer.purchasePath === 'new_registration' && offer.registration?.amount != null,
  );
  candidates.sort((a, b) => {
    const rank = (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9);
    if (rank !== 0) return rank;
    if (a.currency !== b.currency) return a.currency < b.currency ? -1 : 1;
    return new Decimal(a.registration.amount!).cmp(new Decimal(b.registration.amount!));
  });
  const offer: Offer | undefined = candidates[0];
  if (offer) {
    return {
      providerId: offer.providerId,
      kind: offer.kind,
      registration: offer.registration.amount,
      renewal: offer.renewal?.amount ?? null,
      currency: offer.currency,
      observedAt: offer.observedAt,
    };
  }
  if (record.bestPrice) {
    return {
      providerId: record.bestPrice.providerId,
      kind: record.bestPrice.kind,
      registration: record.bestPrice.amount,
      renewal: null,
      currency: record.bestPrice.currency,
      observedAt: record.bestPrice.observedAt,
    };
  }
  return null;
}

/** TXT candidate filter: no registry record, or a provider confirmed the exact name as available. */
export function isCandidate(record: ScopedRecord): boolean {
  return record.registry?.outcome === 'no_record' || record.confirmations.some((c) => c.status === 'available');
}

export function confirmationSummary(record: ScopedRecord): string | null {
  if (!record.confirmations.length) return null;
  return record.confirmations.map((c) => `${c.providerId}:${c.status}`).join('; ');
}

interface Primary {
  outcome: string | null;
  checkedAt: string | null;
  freshness: string | null;
  source: string | null;
  reason: string | null;
}

/**
 * The evidence a row's outcome, check time, freshness, source and reason describe: registry
 * evidence when present; for job items without it, the item's own evidence (provider confirmation,
 * name check, diagnostic, listing or quote). Domain rows never borrow another kind's status as
 * their outcome; confirmations have their own column.
 */
export function primaryEvidence(record: ScopedRecord): Primary {
  const registry = record.registry;
  if (registry) {
    return {
      outcome: registry.outcome,
      checkedAt: registry.checkedAt,
      freshness: registry.freshness,
      source: registry.source?.destination ?? null,
      reason: registry.reason?.message ?? null,
    };
  }
  if (record.itemId) {
    const confirmation = record.confirmations[0];
    if (confirmation) {
      return {
        outcome: record.itemOutcome ?? confirmation.status,
        checkedAt: confirmation.checkedAt,
        freshness: confirmation.freshness,
        source: confirmation.destination,
        reason: confirmation.reason?.message ?? null,
      };
    }
    const other = record.other[0];
    if (other) {
      return { outcome: record.itemOutcome ?? other.outcome, checkedAt: other.checkedAt, freshness: other.freshness, source: other.source, reason: other.reason };
    }
    const offer = record.offers[0];
    if (offer) {
      return { outcome: record.itemOutcome, checkedAt: offer.observedAt, freshness: offer.freshness, source: offer.source?.label ?? null, reason: null };
    }
    return {
      outcome: record.itemOutcome,
      checkedAt: null,
      freshness: null,
      source: record.operation && record.target ? `${record.operation}:${record.target}` : null,
      reason: record.itemError,
    };
  }
  return { outcome: null, checkedAt: null, freshness: null, source: null, reason: 'No registry evidence retained' };
}

export function fieldValue(record: ScopedRecord, field: ExportField, price: PriceSummary | null): string | null {
  const registry = record.registry;
  switch (field) {
    case 'domain':
      return record.domain;
    case 'unicode':
      return record.unicode;
    case 'suffix':
      return record.suffix || null;
    case 'outcome':
      return primaryEvidence(record).outcome;
    case 'checkedAt':
      return primaryEvidence(record).checkedAt;
    case 'freshness':
      return primaryEvidence(record).freshness;
    case 'source':
      return primaryEvidence(record).source;
    case 'protocol':
      return registry?.source?.protocol ?? null;
    case 'reason':
      return primaryEvidence(record).reason;
    case 'eligibility':
      return registry?.eligibility?.status ?? null;
    case 'registrar':
      return registry?.registration?.registrar ?? null;
    case 'expiresAt':
      return registry?.registration?.expiresAt ?? null;
    case 'confirmation':
      return confirmationSummary(record);
    case 'priceProvider':
      return price?.providerId ?? null;
    case 'priceKind':
      return price?.kind ?? null;
    case 'registration':
      return price?.registration ?? null;
    case 'renewal':
      return price?.renewal ?? null;
    case 'currency':
      return price?.currency ?? null;
    case 'priceObservedAt':
      return price?.observedAt ?? null;
    case 'checks':
      // Each check keeps its own outcome and time; they never merge into the registry outcome.
      return record.other.length ? record.other.map((c) => `${c.label}: ${c.outcome} (${c.checkedAt})`).join('; ') : null;
    case 'notes':
      return record.notes;
  }
}

/**
 * One CSV cell. Cells starting with = + - @ (or tab / carriage return) get a leading apostrophe so
 * spreadsheet apps treat them as text, not formulas. Then RFC 4180 quoting applies.
 */
export function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvLine(values: (string | null)[]): string {
  return values.map(csvCell).join(',');
}
