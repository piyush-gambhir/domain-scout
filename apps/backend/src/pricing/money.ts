import { Decimal } from 'decimal.js';







const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export type Dec = InstanceType<typeof D>;

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;






export function parseAmount(value: unknown, options: { stripSymbol?: boolean } = {}): string | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    text = String(value);

    if (/e/i.test(text)) return null;
  } else if (typeof value === 'string') {
    text = value.trim();
    if (options.stripSymbol) {

      if (/[-\u2212\u2012\u2013\u2014\uFE63\uFF0D]/.test(text)) return null;
      text = text.replace(/^[^\d]+/, '').replace(/[^\d.,]+$/, '');
    }
    text = text.replace(/,(?=\d{3}(\D|$))/g, '');
  } else {
    return null;
  }
  if (!PLAIN_DECIMAL.test(text)) return null;
  return format(new D(text));
}


export function fromMinorUnits(value: unknown, currency: string): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  return format(new D(text).dividedBy(new D(10).pow(currencyExponent(currency))));
}


export function currencyExponent(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function dec(amount: string): Dec {
  return new D(amount);
}


export function format(value: Dec): string {
  const fixed = value.toFixed();
  const [whole, fraction = ''] = fixed.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return `${whole}.${trimmed.padEnd(2, '0')}`;
}


export function sum(...amounts: (string | null)[]): string | null {
  let total = new D(0);
  for (const amount of amounts) {
    if (amount === null) return null;
    total = total.plus(amount);
  }
  return format(total);
}


export function multiply(amount: string | null, factor: string | number): string | null {
  if (amount === null) return null;
  return format(new D(amount).times(String(factor)));
}

export function compare(a: string, b: string): number {
  return new D(a).comparedTo(b);
}

export function isZero(amount: string): boolean {
  return new D(amount).isZero();
}
