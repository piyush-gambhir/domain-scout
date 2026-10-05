import { domainToASCII, domainToUnicode } from 'node:url';
import { parse as parseHost } from 'tldts';
import type { InputReason, InputReasonCode, NormalizedDomain } from '@domain-scout/contracts';

/**
 * Validation and normalization of one input entry. Registration boundaries come from the Public
 * Suffix List ICANN section (via tldts) plus the IANA root list; the PSL private section is used
 * only to recognize hosting suffixes such as github.io, never to define a registry domain.
 */

export const MAX_LABEL = 63;
export const MAX_NAME = 253;

export type EntryVerdict =
  | { kind: 'domain'; domain: NormalizedDomain; reasons: InputReason[] }
  | { kind: 'base'; label: string; unicodeLabel: string; reasons: InputReason[] }
  | { kind: 'ambiguous'; reasons: InputReason[]; suggestion: string }
  | { kind: 'invalid'; reasons: InputReason[] };

export function reason(code: InputReasonCode, message: string): InputReason {
  return { code, message };
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LDH = /^[a-z0-9-]+$/;
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7f]/;

/** Trims, strips URL parts, lower-cases and removes one trailing dot, recording each change. */
export function cleanEntry(raw: string): { value: string; reasons: InputReason[] } {
  const reasons: InputReason[] = [];
  let value = raw.trim();
  if (value === '') return { value, reasons };

  const before = value;
  if (SCHEME.test(value)) {
    value = value.replace(SCHEME, '');
    const at = value.search(/[/?#]/);
    const authority = at === -1 ? value : value.slice(0, at);
    value = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  } else {
    const cut = value.search(/[/?#]/);
    if (cut > 0) value = value.slice(0, cut);
  }
  const port = /:\d*$/.exec(value);
  if (port && !value.startsWith('[')) value = value.slice(0, port.index);
  if (value !== before) reasons.push(reason('stripped_url', `Reduced "${before}" to the host name "${value}"`));

  const lower = value.toLowerCase();
  if (lower !== value) {
    reasons.push(reason('normalized_case', 'Converted to lower case'));
    value = lower;
  }
  if (value.endsWith('.') && !value.endsWith('..')) {
    value = value.slice(0, -1);
    reasons.push(reason('trailing_dot_removed', 'Removed the trailing dot'));
  }
  return { value, reasons };
}

/** LDH rules for one ASCII label (after IDN conversion). Returns the first violation, if any. */
export function labelProblem(label: string): InputReason | null {
  if (label === '') return reason('invalid_characters', 'Contains an empty label (consecutive or leading dots)');
  if (label.length > MAX_LABEL) {
    return reason('label_too_long', `Label "${shorten(label)}" has ${label.length} characters; the limit is ${MAX_LABEL}`);
  }
  if (!LDH.test(label)) {
    return reason('invalid_characters', `Label "${shorten(label)}" may contain only letters, digits and hyphens`);
  }
  if (label.startsWith('-') || label.endsWith('-')) {
    return reason('hyphen_position', `Label "${shorten(label)}" cannot start or end with a hyphen`);
  }
  if (label.slice(2, 4) === '--' && !label.startsWith('xn--')) {
    return reason('hyphen_position', `Label "${shorten(label)}" has hyphens in positions 3 and 4, which are reserved for encoded names`);
  }
  if (label.startsWith('xn--')) {
    const unicode = domainToUnicode(label);
    if (unicode === '' || unicode === label || domainToASCII(unicode) !== label) {
      return reason('idn_invalid', `"${shorten(label)}" is not a valid internationalized (xn--) label`);
    }
  }
  return null;
}

function shorten(text: string) {
  return text.length > 70 ? `${text.slice(0, 67)}...` : text;
}

/** Converts to an A-label form, or explains why that is impossible. */
export function toAscii(value: string): { ascii: string } | { problem: InputReason } {
  if (/\s/.test(value)) return { problem: reason('invalid_characters', 'Contains whitespace') };
  // URL host processing would percent-decode or drop some ASCII (acme%2ecom, a\b); refuse it up front.
  const badAscii = /[\x00-\x2c\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]/.exec(value);
  if (badAscii) return { problem: reason('invalid_characters', `Contains "${badAscii[0]}", which is not allowed in domain names`) };
  const hasNonAscii = NON_ASCII.test(value);
  const ascii = domainToASCII(value);
  if (ascii === '') {
    if (hasNonAscii || /(^|\.)xn--/.test(value)) {
      return { problem: reason('idn_invalid', 'Cannot be converted to a valid internationalized domain name') };
    }
    return { problem: reason('invalid_characters', 'Contains characters that are not allowed in domain names') };
  }
  return { ascii };
}

export interface SuffixLookup {
  /** True when the TLD is in the IANA root zone list. */
  isRootTld(tld: string): boolean;
}

/** Classifies a cleaned entry: a complete domain, a base name to expand, or an excluded row. */
export function classifyEntry(value: string, suffixes: SuffixLookup): EntryVerdict {
  if (value === '') return { kind: 'invalid', reasons: [reason('empty', 'Empty entry')] };

  if (value.startsWith('.')) {
    const rest = value.replace(/^\.+/, '');
    const converted = toAscii(rest);
    if ('ascii' in converted && converted.ascii !== '' && isPublicSuffix(converted.ascii, suffixes)) {
      return { kind: 'invalid', reasons: [reason('suffix_only', `"${value}" is an extension, not a domain`)] };
    }
    return { kind: 'invalid', reasons: [reason('invalid_characters', 'Starts with a dot')] };
  }

  const converted = toAscii(value);
  if ('problem' in converted) return { kind: 'invalid', reasons: [converted.problem] };
  const ascii = converted.ascii;
  const reasons: InputReason[] = [];
  const isIdnInput = NON_ASCII.test(value);

  if (!ascii.includes('.')) {
    const problem = labelProblem(ascii);
    if (problem) return { kind: 'invalid', reasons: [problem] };
    if (isIdnInput) reasons.push(reason('idn_converted', `Converted "${value}" to "${ascii}"`));
    return { kind: 'base', label: ascii, unicodeLabel: domainToUnicode(ascii) || value, reasons };
  }

  return classifyDomain(ascii, isIdnInput ? value : null, suffixes);
}

/** Complete (dotted) A-label name: validates labels and the registration boundary. */
export function classifyDomain(ascii: string, originalUnicode: string | null, suffixes: SuffixLookup): EntryVerdict {
  const reasons: InputReason[] = [];
  for (const label of ascii.split('.')) {
    const problem = labelProblem(label);
    if (problem) return { kind: 'invalid', reasons: [problem] };
  }
  if (ascii.length > MAX_NAME) {
    return { kind: 'invalid', reasons: [reason('name_too_long', `Name has ${ascii.length} characters; the limit is ${MAX_NAME}`)] };
  }
  if (originalUnicode !== null) reasons.push(reason('idn_converted', `Converted "${originalUnicode}" to "${ascii}"`));

  const tld = ascii.slice(ascii.lastIndexOf('.') + 1);
  const icann = parseHost(ascii, { allowPrivateDomains: false, extractHostname: false, validateHostname: false, detectIp: false });
  let suffix = icann.isIcann ? icann.publicSuffix : null;
  let registrable = icann.isIcann ? icann.domain : null;
  if (!suffix && suffixes.isRootTld(tld)) {
    // Delegated TLD missing from the bundled Public Suffix List: the TLD is the only known boundary.
    suffix = tld;
    registrable = ascii.split('.').slice(-2).join('.');
  }
  if (!suffix) {
    return { kind: 'invalid', reasons: [...reasons, reason('unknown_suffix', `".${tld}" is not a delegated top-level domain`)] };
  }
  if (!registrable) {
    return { kind: 'invalid', reasons: [...reasons, reason('suffix_only', `"${ascii}" is a registry extension, not a registrable domain`)] };
  }

  const privateParse = parseHost(ascii, { allowPrivateDomains: true, extractHostname: false, validateHostname: false, detectIp: false });
  if (privateParse.isPrivate && privateParse.publicSuffix && privateParse.publicSuffix !== ascii) {
    return {
      kind: 'invalid',
      reasons: [
        ...reasons,
        reason(
          'private_suffix',
          `"${ascii}" is under ${privateParse.publicSuffix}, a private service suffix in the Public Suffix List; names under it are not registry registrations`,
        ),
      ],
    };
  }

  if (registrable !== ascii) {
    return {
      kind: 'ambiguous',
      suggestion: registrable,
      reasons: [...reasons, reason('hostname_not_registrable', `"${ascii}" is a host name under the registrable domain ${registrable}`)],
    };
  }

  const label = ascii.slice(0, ascii.length - suffix.length - 1);
  const isIdn = ascii.split('.').some((part) => part.startsWith('xn--'));
  if (isIdn) {
    reasons.push(
      reason('idn_support_unknown', `Registry rules for internationalized names under .${suffix} are not checked here; the registry may reject this name`),
    );
  }
  return {
    kind: 'domain',
    reasons,
    domain: { ascii, unicode: domainToUnicode(ascii) || ascii, label, suffix, isIdn },
  };
}

function isPublicSuffix(ascii: string, suffixes: SuffixLookup): boolean {
  const icann = parseHost(ascii, { allowPrivateDomains: false, extractHostname: false, validateHostname: false });
  if (icann.isIcann && icann.publicSuffix === ascii) return true;
  return !ascii.includes('.') && suffixes.isRootTld(ascii);
}
