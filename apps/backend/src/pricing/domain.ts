import { domainToASCII } from 'node:url';
import { getPublicSuffix } from 'tldts';
import type { InputPreviewer } from '../core/ports.js';
import { AppError } from '../core/errors.js';

export interface DomainRef {
  ascii: string;
  suffix: string;
}

/**
 * Normalizes a domain from a route or import row. Prefers the registry module's previewer (suffix
 * rules and IDN handling); falls back to the ICANN section of the Public Suffix List.
 */
export function normalizeDomain(input: string, previewer: InputPreviewer | null): DomainRef | null {
  const trimmed = input.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed) return null;
  const normalized = previewer?.normalize(trimmed);
  if (normalized) return { ascii: normalized.ascii, suffix: normalized.suffix };
  if (previewer) return null;
  const ascii = domainToASCII(trimmed);
  if (!ascii || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(ascii) || ascii.length > 253) return null;
  const suffix = getPublicSuffix(ascii, { allowPrivateDomains: false });
  if (!suffix || suffix === ascii) return null;
  const label = ascii.slice(0, -(suffix.length + 1));
  if (!label || label.includes('.')) return null;
  return { ascii, suffix };
}

export function requireDomain(input: string, previewer: InputPreviewer | null): DomainRef {
  const ref = normalizeDomain(input, previewer);
  if (!ref) throw AppError.invalid(`Not a registrable domain: ${input.slice(0, 100)}`);
  return ref;
}
