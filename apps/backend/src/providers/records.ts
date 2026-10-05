import { randomUUID } from 'node:crypto';
import { Offer, type ProviderConfirmation } from '@domain-scout/contracts';
import type { ObservationWrite, OfferWrite } from '../storage/evidence.js';
import { ProviderError, type CheckResult, type OfferDraft } from './adapters/types.js';

/**
 * A draft with provider-supplied text scrubbed (source label and URL, fee labels, promotion text,
 * region, listing destination). Providers can echo request parameters, including credentials, in
 * successful responses too.
 */
export function scrubDraft<T extends OfferDraft>(draft: T, scrub: (text: string) => string): T {
  const promotion = draft.promotion;
  return {
    ...draft,
    region: draft.region === null ? null : scrub(draft.region),
    fees: { ...draft.fees, other: draft.fees.other.map((fee) => ({ ...fee, label: scrub(fee.label) })) },
    promotion: promotion
      ? { ...promotion, description: scrub(promotion.description), restrictions: promotion.restrictions === null ? null : scrub(promotion.restrictions) }
      : null,
    source: { label: scrub(draft.source.label), url: draft.source.url === null ? null : scrub(draft.source.url) },
    ...(draft.destination ? { destination: { ...draft.destination, url: scrub(draft.destination.url) } } : {}),
  };
}

/**
 * Builds the stored offer row and its contract payload (payload omits computed freshness). The
 * payload must be a valid contract Offer: a malformed one (fractional years, a bad currency code)
 * throws a bad_response ProviderError instead of being persisted.
 */
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
  const checked = Offer.safeParse({ ...payload, freshness: 'fresh' });
  if (!checked.success) {
    const issue = checked.error.issues[0]!;
    throw new ProviderError(
      'bad_response',
      `${input.providerId} returned a malformed price for .${input.suffix}: ${issue.path.join('.') || 'offer'} ${issue.message}`,
    );
  }
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
