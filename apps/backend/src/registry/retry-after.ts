
const MAX_DATE_MS = 8.64e15;





export function parseRetryAfter(value: string | null | undefined, now: Date): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) {
    const at = now.getTime() + Number(text) * 1000;

    return Number.isFinite(at) && Math.abs(at) <= MAX_DATE_MS ? new Date(at).toISOString() : null;
  }

  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return new Date(Math.max(at, now.getTime())).toISOString();
}

export function plusSeconds(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}
