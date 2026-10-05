import { randomUUID } from 'node:crypto';
import type { Offer, ProviderConfirmation } from '@domain-scout/contracts';
import type { ObservationWrite, OfferWrite } from '../storage/evidence.js';
import type { CheckResult, OfferDraft } from './adapters/types.js';

/** Builds the stored offer row and its contract payload (payload omits computed freshness). */
export function offerRecord(input: {
  providerId: string;
  domain: string | null;
  suffix: string;
  draft: OfferDraft;
  observedAt: string;
  staleAt: string;
  destination: Offer['destination'];
  catalogFetchId?: string | null;
}): { write: OfferWrite; payload: Omit<Offer, 'freshness'> } {
  const { draft } = input;
  const id = randomUUID();
  const payload: Omit<Offer, 'freshness'> = {
    id,
    providerId: input.providerId,
    domain: input.domain,
    suffix: input.suffix,
    purchasePath: draft.purchasePath,
    kind: draft.kind,
    currency: draft.currency,
    region: draft.region,
    registration: draft.registration,
    minYears: draft.minYears,
    renewal: draft.renewal,
    transfer: draft.transfer,
    fees: draft.fees,
    premium: draft.premium,
    promotion: draft.promotion,
    observedAt: input.observedAt,
    publishedAt: draft.publishedAt,
    quoteExpiresAt: draft.quoteExpiresAt,
    staleAt: input.staleAt,
    source: draft.source,
    destination: input.destination,
  };
  const write: OfferWrite = {
    id,
    providerId: input.providerId,
    domain: input.domain,
    suffix: input.suffix,
    purchasePath: draft.purchasePath,
    kind: draft.kind,
    currency: draft.currency,
    region: draft.region,
    termYears: draft.registration.years,
    promotional: draft.promotional,
    registration: draft.registration.amount,
    renewal: draft.renewal.amount,
    transfer: draft.transfer.amount,
    observedAt: input.observedAt,
    staleAt: input.staleAt,
    quoteExpiresAt: draft.quoteExpiresAt,
    catalogFetchId: input.catalogFetchId ?? null,
    payload: payload as unknown as Record<string, unknown>,
  };
  return { write, payload };
}

/** Provider confirmation observation (kind 'confirmation'), independent of registry evidence. */
export function confirmationRecord(input: {
  providerId: string;
  domain: string;
  suffix: string;
  check: CheckResult;
  checkedAt: string;
  staleAt: string;
  destination: string;
}): { write: ObservationWrite; payload: Omit<ProviderConfirmation, 'freshness'> } {
  const id = randomUUID();
  const payload: Omit<ProviderConfirmation, 'freshness'> = {
    id,
    providerId: input.providerId,
    domain: input.domain,
    status: input.check.status,
    premium: input.check.premium,
    checkedAt: input.checkedAt,
    staleAt: input.staleAt,
    destination: input.destination,
    reason: input.check.reason,
  };
  return {
    write: {
      id,
      kind: 'confirmation',
      subject: input.domain,
      suffix: input.suffix,
      sourceId: input.providerId,
      destination: input.destination,
      outcome: input.check.status,
      observedAt: input.checkedAt,
      staleAt: input.staleAt,
      payload: payload as unknown as Record<string, unknown>,
    },
    payload,
  };
}
