import { createHash } from 'node:crypto';
import { json } from '../storage/database.js';

/** Offer payload fields that decide whether two prices measure the same thing. */
export interface ComparablePayload {
  renewal?: { years?: number };
  transfer?: { includesYears?: number | null };
  promotion?: {
    description?: string;
    requiresTermYears?: number | null;
    expiresAt?: string | null;
    restrictions?: string | null;
  } | null;
}

/**
 * Stable signature of a promotion's conditions (description, required term, expiry, customer or
 * account restrictions), so different campaigns never share a trend or produce a price-change notice.
 */
export function promotionSignature(promotional: boolean, promotion: ComparablePayload['promotion']): string {
  if (!promotional) return 'regular';
  if (!promotion) return 'promo';
  const conditions = JSON.stringify([
    promotion.description ?? '',
    promotion.requiresTermYears ?? null,
    promotion.expiresAt ?? null,
    promotion.restrictions ?? null,
  ]);
  return `promo:${createHash('sha256').update(conditions).digest('hex').slice(0, 16)}`;
}

/**
 * Terms beyond the indexed columns (provider, scope, path, kind, currency, region, registration
 * term) that must also match: renewal covered years, transfer-included years and promotion conditions.
 */
export function comparableTerms(promotional: boolean, payloadJson: string): string {
  const payload = json.parse<ComparablePayload>(payloadJson, {});
  return [
    `renew${payload.renewal?.years ?? 1}y`,
    `transfer${payload.transfer?.includesYears ?? '?'}y`,
    promotionSignature(promotional, payload.promotion),
  ].join('|');
}
