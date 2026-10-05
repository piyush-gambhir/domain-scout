import type { Offer } from '@domain-scout/contracts';

/** Compares non-negative decimal strings exactly (no floats). */
export function compareDecimal(a: string, b: string): number {
  const [ai = '0', af = ''] = a.split('.');
  const [bi = '0', bf = ''] = b.split('.');
  const aInt = ai.replace(/^0+(?=\d)/, '');
  const bInt = bi.replace(/^0+(?=\d)/, '');
  if (aInt.length !== bInt.length) return aInt.length - bInt.length;
  if (aInt !== bInt) return aInt < bInt ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  const aFrac = af.padEnd(width, '0');
  const bFrac = bf.padEnd(width, '0');
  return aFrac === bFrac ? 0 : aFrac < bFrac ? -1 : 1;
}

/**
 * Lowest known new-registration offer among comparable ones: same currency and same term. One-year
 * terms are preferred, then the largest comparable group. Unknown amounts are never treated as zero,
 * and offers with different terms or currencies are never ranked against each other.
 */
export function lowestRegistrationOffer(offers: Offer[]): Offer | null {
  const priced = offers.filter((o) => o.purchasePath === 'new_registration' && o.registration.amount !== null);
  if (priced.length === 0) return null;
  const groups = new Map<string, Offer[]>();
  for (const offer of priced) {
    const key = `${offer.currency}|${offer.registration.years}`;
    groups.set(key, [...(groups.get(key) ?? []), offer]);
  }
  const group = [...groups.values()].sort(
    (a, b) => Number(b[0]!.registration.years === 1) - Number(a[0]!.registration.years === 1) || b.length - a.length,
  )[0]!;
  return group.reduce((best, offer) => (compareDecimal(offer.registration.amount!, best.registration.amount!) < 0 ? offer : best));
}
