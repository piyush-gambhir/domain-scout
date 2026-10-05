/** Limits for untrusted registry text kept as evidence or raw diagnostics. */
export const MAX_RAW_CHARS = 256 * 1024;
export const MAX_FIELD_CHARS = 300;

/**
 * Normalizes line endings, removes control characters other than tab and newline, and caps the
 * length. Used for raw diagnostics so stored text is inert when displayed or exported.
 */
export function sanitizeText(text: string, max = MAX_RAW_CHARS): { text: string; truncated: boolean } {
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '');
  if (cleaned.length <= max) return { text: cleaned, truncated: false };
  return { text: cleaned.slice(0, max), truncated: true };
}

/** One display field from a source (registrar name, status): single line, bounded. */
export function sanitizeField(value: unknown, max = MAX_FIELD_CHARS): string | null {
  if (typeof value !== 'string') return null;
  const text = sanitizeText(value, max).text.replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** ISO timestamp for a parseable date, else null. */
export function toIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const at = Date.parse(value.trim());
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** Lower-case host name without a trailing dot. */
export function normalizeHostName(value: unknown): string | null {
  const text = sanitizeField(value, 253);
  return text ? text.toLowerCase().replace(/\.$/, '') : null;
}
