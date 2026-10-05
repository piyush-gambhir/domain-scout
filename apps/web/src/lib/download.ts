/*
 * Client-side files built from API responses already on screen. Nothing is fetched and no
 * request headers, cookies or tokens are read, so a file holds only the data it was given.
 */

/** Saves text as a file through a temporary object URL. */
export function downloadText(fileName: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** UTC time as 20261005T120000Z, for file names. */
export function fileStamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** File-name part describing a scope, e.g. "suffix-com_provider-porkbun", or "all". */
export function scopeSlug(parts: Record<string, string | undefined>): string {
  const named = Object.entries(parts)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}-${value.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)}`);
  return named.length ? named.join('_') : 'all';
}

/**
 * One CSV cell: values starting with = + - @ (or tab / carriage return) get a leading apostrophe
 * so spreadsheets treat them as text, then RFC 4180 quoting. Same rule as backend exports.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvText(header: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
