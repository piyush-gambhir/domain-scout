import type { Eligibility, NormalizedDomain, RegistrationDetails } from '@domain-scout/contracts';
import { domainToASCII } from 'node:url';
import { NO_RECORD_NOTE, UNKNOWN_ELIGIBILITY, unresolved, type Classification } from '../classification.js';
import { plusSeconds } from '../retry-after.js';
import { normalizeHostName, sanitizeField, toIso } from '../sanitize.js';
import type { WhoisRouteSpec } from '../data.js';







export interface WhoisContext {
  domain: NormalizedDomain;
  spec: WhoisRouteSpec;
  now: Date;
}

export interface WhoisParser {
  id: string;
  version: string;
  classify(text: string, ctx: WhoisContext): Classification;
}


export function classifyWhois(parser: WhoisParser, response: { text: string; truncated: boolean }, ctx: WhoisContext): Classification {
  const host = ctx.spec.host;
  if (response.text.trim() === '') {
    return unresolved('inconclusive', 'empty_response', `${host} sent an empty reply`, { retryable: true });
  }
  if (response.truncated) {
    return unresolved('inconclusive', 'truncated_response', `${host} reply was cut off (size limit or dropped connection)`, { retryable: true });
  }
  return parser.classify(response.text.replace(/\r\n?/g, '\n'), ctx);
}

export const UNRECOGNIZED = (host: string) =>
  unresolved('inconclusive', 'unrecognized_response', `${host} reply did not match any known registered, free or error pattern`);


export const INCOMPLETE = (host: string, missing: string) =>
  unresolved('inconclusive', 'incomplete_record', `${host} reply names the domain but lacks ${missing}`, { retryable: true });

export function rateLimited(ctx: WhoisContext, detail: string, seconds = ctx.spec.rateLimitCooldownSeconds): Classification {
  const cooldownUntil = plusSeconds(ctx.now, seconds);
  return unresolved('rate_limited', 'rate_limited', `${ctx.spec.host} throttled the query: ${detail}`, {
    retryable: true,
    cooldownUntil,
    retryAt: cooldownUntil,
  });
}

export function mismatch(ctx: WhoisContext, returned: string): Classification {
  return unresolved('inconclusive', 'identity_mismatch', `${ctx.spec.host} returned data for ${returned}, not ${ctx.domain.ascii}`, {
    matchedName: returned,
  });
}

export function noRecord(ctx: WhoisContext, matchedName: string | null, detail: string): Classification {
  return {
    outcome: 'no_record',
    reason: { code: 'registry_not_found', message: `${ctx.spec.host} ${detail}. ${NO_RECORD_NOTE}` },
    httpStatus: null,
    matchedName,
    registration: null,
    eligibility: UNKNOWN_ELIGIBILITY,
    retryable: false,
    cooldownUntil: null,
    retryAt: null,
  };
}

export function registered(ctx: WhoisContext, matchedName: string, registration: RegistrationDetails, eligibility: Eligibility = UNKNOWN_ELIGIBILITY): Classification {
  return {
    outcome: 'registered',
    reason: { code: 'registry_record', message: `${ctx.spec.host} returned a registration record for ${ctx.domain.ascii}` },
    httpStatus: null,
    matchedName,
    registration,
    eligibility,
    retryable: false,
    cooldownUntil: null,
    retryAt: null,
  };
}


export function asciiName(value: string | undefined): string | null {
  if (!value) return null;
  const name = value.trim().toLowerCase().replace(/\.$/, '');

  if (name === '' || /[\s/?#@:\\%"']/.test(name)) return null;
  return domainToASCII(name) || null;
}

export function first(text: string, pattern: RegExp): string | undefined {
  return pattern.exec(text)?.[1]?.trim();
}

export function all(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]!.trim());
}

export function hosts(values: string[]): string[] {
  return values.map((value) => normalizeHostName(value)).filter((value): value is string => value !== null).slice(0, 20);
}

export function fields(values: string[], max = 30): string[] {
  return values.map((value) => sanitizeField(value, 80)).filter((value): value is string => value !== null).slice(0, max);
}


export function localToIso(value: string | undefined, offset: string): string | null {
  if (!value) return null;
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = match;
  return toIso(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`);
}

export const NO_DETAILS: RegistrationDetails = {
  registrar: null,
  createdAt: null,
  updatedAt: null,
  expiresAt: null,
  statuses: [],
  nameservers: [],
  dnssec: null,
};


export function noRecordStated(ctx: WhoisContext, matchedName: string | null, detail: string, eligibility: Eligibility): Classification {
  return { ...noRecord(ctx, matchedName, detail), eligibility };
}

export function unknownStatus(ctx: WhoisContext, status: string, matchedName: string | null): Classification {
  return unresolved('inconclusive', 'unknown_status', `${ctx.spec.host} reported an unknown status "${sanitizeField(status, 60)}"`, { matchedName });
}


export function blockedBy(ctx: WhoisContext, detail: string, seconds: number): Classification {
  const cooldownUntil = plusSeconds(ctx.now, seconds);
  return unresolved('blocked', 'blocked', `${ctx.spec.host} refused the query: ${detail}`, { cooldownUntil, retryAt: cooldownUntil });
}


export function registryInvalid(ctx: WhoisContext, matchedName: string | null, detail: string, source: string): Classification {
  return {
    ...unresolved('inconclusive', 'registry_reports_invalid', `${ctx.spec.host} ${detail}`),
    outcome: 'invalid',
    matchedName,
    eligibility: { status: 'restricted', source, scope: `.${ctx.spec.tld} registration policy for this name` },
  };
}





export function block(text: string, header: RegExp): string[] {
  const match = header.exec(text);
  if (!match) return [];
  const indent = /^[ \t]*/.exec(match[0])![0].length;
  const out: string[] = [];
  for (const line of text.slice(match.index + match[0].length).replace(/^\n/, '').split('\n')) {
    const depth = /^[ \t]*/.exec(line)![0].length;
    if (line.trim() === '' || depth <= indent) break;
    out.push(line.trim());
  }
  return out;
}


export function dateOnly(value: string | undefined): string | null {
  const text = value?.trim() ?? '';
  const ymd = /^(\d{4})-?(\d{2})-?(\d{2})(?:\D|$)/.exec(text);
  if (ymd) return toIso(`${ymd[1]}-${ymd[2]}-${ymd[3]}T00:00:00Z`);
  const dmy = /^(\d{2})[./-](\d{2})[./-](\d{4})(?:\D|$)/.exec(text);
  return dmy ? toIso(`${dmy[3]}-${dmy[2]}-${dmy[1]}T00:00:00Z`) : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];


export function dayMonthYear(day: string, month: string, year: string): string | null {
  const index = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
  if (index === -1) return null;
  return toIso(`${year}-${String(index + 1).padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00Z`);
}






export function names(text: string, pattern: RegExp): string[] {
  return [...new Set(all(text, pattern).map((value) => asciiName(value) ?? ''))];
}


export function values(text: string, pattern: RegExp): string[] {
  return [...new Set(all(text, pattern).map((value) => value.toLowerCase()))];
}


export function conflicting(ctx: WhoisContext, what: string): Classification {
  return unresolved('inconclusive', 'conflicting_reply', `${ctx.spec.host} reply contains conflicting ${what}`);
}
