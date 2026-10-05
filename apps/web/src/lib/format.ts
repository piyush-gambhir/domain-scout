/* Formatting helpers. Money stays a decimal string end to end; nothing here converts it to a float. */

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });
const dateTime = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });
const number = new Intl.NumberFormat('en');

export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unknown' : number.format(value);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Unknown';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Unknown';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateOnly.format(date);
}

export function formatRelative(iso: string | null | undefined, now: number): string {
  if (!iso) return 'Unknown';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const seconds = Math.round((time - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return seconds <= 0 ? 'just now' : 'in a moment';
  if (abs < 45 * 60) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 22 * 3600) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 26 * 86400) return relative.format(Math.round(seconds / 86400), 'day');
  if (abs < 320 * 86400) return relative.format(Math.round(seconds / (30 * 86400)), 'month');
  return relative.format(Math.round(seconds / (365 * 86400)), 'year');
}

const symbols = new Map<string, { symbol: string; prefix: boolean }>();

function currencySymbol(currency: string): { symbol: string; prefix: boolean } {
  const cached = symbols.get(currency);
  if (cached) return cached;
  let result = { symbol: `${currency} `, prefix: true };
  try {
    const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency }).formatToParts(1);
    const index = parts.findIndex((p) => p.type === 'currency');
    const symbol = parts[index]?.value;
    if (symbol) {
      const prefix = index === 0;
      const spaced = symbol.length > 1 && /^[A-Z]+$/.test(symbol);
      result = { symbol: spaced ? (prefix ? `${symbol} ` : ` ${symbol}`) : symbol, prefix };
    }
  } catch {
    // Unknown currency code: fall back to the code itself.
  }
  symbols.set(currency, result);
  return result;
}

/** Groups the integer part and pads to two decimals without losing precision. */
export function formatDecimal(amount: string): string {
  const negative = amount.startsWith('-');
  const [intPart = '0', fraction = ''] = (negative ? amount.slice(1) : amount).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = fraction.length >= 2 ? fraction : fraction.padEnd(2, '0');
  return `${negative ? '-' : ''}${grouped}.${frac}`;
}

export function formatMoney(amount: string | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return 'Unknown';
  const value = formatDecimal(amount);
  if (!currency) return value;
  const { symbol, prefix } = currencySymbol(currency);
  return prefix ? `${symbol}${value}` : `${value}${symbol}`;
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
