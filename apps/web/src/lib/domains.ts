import { uniq } from './utils';

const ASCII_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Complete domains from free entry (lines, commas, spaces). URLs lose their scheme and path,
 * Unicode names become their ASCII (punycode) form. Nothing is sent anywhere.
 */
export function parseDomains(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const token = raw.trim();
    if (!token) continue;
    let value = token
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/[/?#].*$/, '')
      .replace(/\.+$/, '');
    if (!ASCII_DOMAIN.test(value)) {
      try {
        value = new URL(`http://${value}`).hostname;
      } catch {
        value = '';
      }
    }
    if (value && ASCII_DOMAIN.test(value) && value.length >= 3 && value.length <= 253) valid.push(value);
    else invalid.push(token);
  }
  return { valid: uniq(valid), invalid };
}
