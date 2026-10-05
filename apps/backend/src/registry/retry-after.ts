/** Largest absolute millisecond value a JavaScript Date can hold. */
const MAX_DATE_MS = 8.64e15;

/**
 * Parses an HTTP Retry-After value (RFC 9110 section 10.2.3): delay seconds or an HTTP-date.
 * Returns the absolute ISO time, never earlier than `now`, or null when absent or unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, now: Date): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) {
    const at = now.getTime() + Number(text) * 1000;
    // Values beyond the Date range (about 275,000 years) are not usable delays.
    return Number.isFinite(at) && Math.abs(at) <= MAX_DATE_MS ? new Date(at).toISOString() : null;
  }
  // HTTP-date forms; Date.parse accepts IMF-fixdate, RFC 850 and asctime.
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return new Date(Math.max(at, now.getTime())).toISOString();
}

export function plusSeconds(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}
