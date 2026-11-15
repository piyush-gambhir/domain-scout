import type { Offer } from '@domain-scout/contracts';


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

function scaleOf(value: string): number {
  return value.split('.')[1]?.length ?? 0;
}

function toScaled(value: string, scale: number): bigint {
  const negative = value.startsWith('-');
  const [int = '0', frac = ''] = (negative ? value.slice(1) : value).split('.');
  const scaled = BigInt(int + frac.padEnd(scale, '0'));
  return negative ? -scaled : scaled;
}

function fromScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  const frac = scale ? `.${digits.slice(digits.length - scale)}` : '';
  return `${negative ? '-' : ''}${int}${frac}`;
}


export function addDecimal(...values: string[]): string {
  const scale = Math.max(0, ...values.map(scaleOf));
  return fromScaled(
    values.reduce((sum, v) => sum + toScaled(v, scale), 0n),
    scale,
  );
}


export function multiplyDecimal(value: string, times: number): string {
  const scale = scaleOf(value);
  return fromScaled(toScaled(value, scale) * BigInt(times), scale);
}





export function horizonEstimate(registration: string | null, registrationYears: number, renewal: string | null, renewalYears: number, horizon: number): string | null {
  if (registration === null) return null;
  const extra = horizon - registrationYears;
  if (extra <= 0) return registration;
  if (renewal === null || renewalYears !== 1) return null;
  return addDecimal(registration, multiplyDecimal(renewal, extra));
}
