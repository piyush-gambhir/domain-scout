import type { Eligibility, NormalizedDomain, RegistrationDetails } from '@domain-scout/contracts';
import { domainToASCII } from 'node:url';
import { NO_RECORD_NOTE, UNKNOWN_ELIGIBILITY, unresolved, type Classification } from '../classification.js';
import { plusSeconds } from '../retry-after.js';
import { normalizeHostName, sanitizeField, toIso } from '../sanitize.js';
import type { WhoisRouteSpec } from '../data.js';

/**
 * Registry-specific WHOIS classifiers. Each one names exact positive, negative and throttle/error
 * patterns for its registry; text that matches none of them is inconclusive. There is deliberately
 * no generic "short reply means free" rule (the failure mode found in reference projects).
 */
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

/** Applies the checks shared by every registry, then the registry's own classifier. */
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

const UNRECOGNIZED = (host: string) =>
  unresolved('inconclusive', 'unrecognized_response', `${host} reply did not match any known registered, free or error pattern`);

/** A name line without the rest of the registry's record shape may be a reply cut short. */
const INCOMPLETE = (host: string, missing: string) =>
  unresolved('inconclusive', 'incomplete_record', `${host} reply names the domain but lacks ${missing}`, { retryable: true });

function rateLimited(ctx: WhoisContext, detail: string, seconds = ctx.spec.rateLimitCooldownSeconds): Classification {
  const cooldownUntil = plusSeconds(ctx.now, seconds);
  return unresolved('rate_limited', 'rate_limited', `${ctx.spec.host} throttled the query: ${detail}`, {
    retryable: true,
    cooldownUntil,
    retryAt: cooldownUntil,
  });
}

function mismatch(ctx: WhoisContext, returned: string): Classification {
  return unresolved('inconclusive', 'identity_mismatch', `${ctx.spec.host} returned data for ${returned}, not ${ctx.domain.ascii}`, {
    matchedName: returned,
  });
}

function noRecord(ctx: WhoisContext, matchedName: string | null, detail: string): Classification {
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

function registered(ctx: WhoisContext, matchedName: string, registration: RegistrationDetails, eligibility: Eligibility = UNKNOWN_ELIGIBILITY): Classification {
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

/** A-label form of a name printed by a registry (may be upper case or Unicode). */
function asciiName(value: string | undefined): string | null {
  if (!value) return null;
  const name = value.trim().toLowerCase().replace(/\.$/, '');
  return name === '' ? null : domainToASCII(name) || null;
}

function first(text: string, pattern: RegExp): string | undefined {
  return pattern.exec(text)?.[1]?.trim();
}

function all(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]!.trim());
}

function hosts(values: string[]): string[] {
  return values.map((value) => normalizeHostName(value)).filter((value): value is string => value !== null).slice(0, 20);
}

function fields(values: string[], max = 30): string[] {
  return values.map((value) => sanitizeField(value, 80)).filter((value): value is string => value !== null).slice(0, max);
}

/** Local date-time with a fixed registry offset (e.g. +09:00 for JPRS) to ISO. */
function localToIso(value: string | undefined, offset: string): string | null {
  if (!value) return null;
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = match;
  return toIso(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`);
}

/**
 * DENIC (.de), queried with `-T dn,ace`. Status values from DENIC's domain status documentation
 * (https://docs.denic.de/en/Content/DENIC-29/Domain-Status.htm): connect, failed and
 * redemptionPeriod are registered objects; free has no registration; invalid cannot be registered.
 * Throttle: "% Error: 55000000002 Connection refused; access control limit reached." (also seen as
 * "exceeded").
 */
const denic: WhoisParser = {
  id: 'denic',
  version: 'whois-denic/1',
  classify(text, ctx) {
    if (/^%[ \t]*Error:[ \t]*55000000002\b/m.test(text) || /access control limit (?:reached|exceeded)/i.test(text)) {
      return rateLimited(ctx, 'DENIC access control limit');
    }
    const error = /^%[ \t]*Error:[ \t]*(\d+)[ \t]*(.*)$/m.exec(text);
    if (error) {
      return unresolved('inconclusive', 'registry_error', `${ctx.spec.host} answered with error ${error[1]} ${sanitizeField(error[2]) ?? ''}`.trim());
    }
    const name = asciiName(first(text, /^Domain-Ace:[ \t]*(\S+)[ \t]*$/m)) ?? asciiName(first(text, /^Domain:[ \t]*(.+?)[ \t]*$/m));
    const status = first(text, /^Status:[ \t]*(\S+)[ \t]*$/m)?.toLowerCase();
    if (!name || !status) return UNRECOGNIZED(ctx.spec.host);
    if (name !== ctx.domain.ascii) return mismatch(ctx, name);

    if (status === 'free') return noRecord(ctx, name, 'reports status free (no registration)');
    if (status === 'invalid') {
      return {
        ...unresolved('inconclusive', 'registry_reports_invalid', `${ctx.spec.host} reports status invalid: DENIC will not register this name`),
        outcome: 'invalid',
        matchedName: name,
        eligibility: {
          status: 'restricted',
          source: 'DENIC WHOIS status "invalid" (https://docs.denic.de/en/Content/DENIC-29/Domain-Status.htm)',
          scope: '.de registration policy for this name',
        },
      };
    }
    if (status === 'connect' || status === 'failed' || status === 'redemptionperiod') {
      return registered(ctx, name, {
        registrar: null,
        createdAt: null,
        updatedAt: toIso(first(text, /^Changed:[ \t]*(\S+)[ \t]*$/m)),
        expiresAt: null,
        statuses: fields([first(text, /^Status:[ \t]*(\S+)[ \t]*$/m) ?? status]),
        nameservers: hosts(all(text, /^Nserver:[ \t]*(\S+)/gm)),
        dnssec: /^Dnskey:/m.test(text) ? true : null,
      });
    }
    return unresolved('inconclusive', 'unknown_status', `${ctx.spec.host} reported an unknown status "${sanitizeField(status, 40)}"`, { matchedName: name });
  },
};

/**
 * .io registry WHOIS (Identity Digital back end). Free: "Domain not found." Registered: ICANN-style
 * key/value record starting with "Domain Name:". Identity Digital documents a per-IP limit but no
 * throttle text, so throttling falls through to inconclusive. The terms of use mention "too many
 * queries", so no loose wording is ever treated as a throttle signal.
 */
const nicIo: WhoisParser = {
  id: 'nic-io',
  version: 'whois-nic-io/1',
  classify(text, ctx) {
    const nameLine = first(text, /^Domain Name:[ \t]*(\S+)[ \t]*$/im);
    if (nameLine) {
      const name = asciiName(nameLine);
      if (!name) return UNRECOGNIZED(ctx.spec.host);
      if (name !== ctx.domain.ascii) return mismatch(ctx, name);
      if (!/^Creation Date:[ \t]*\S/m.test(text) || !/^(?:Registrar|Registry Domain ID):[ \t]*\S/m.test(text)) {
        return INCOMPLETE(ctx.spec.host, 'Creation Date and Registrar lines');
      }
      const dnssec = first(text, /^DNSSEC:[ \t]*(\S+)/m)?.toLowerCase();
      return registered(ctx, name, {
        registrar: sanitizeField(first(text, /^Registrar:[ \t]*(.+)$/m)),
        createdAt: toIso(first(text, /^Creation Date:[ \t]*(\S+)/m)),
        updatedAt: toIso(first(text, /^Updated Date:[ \t]*(\S+)/m)),
        expiresAt: toIso(first(text, /^Registry Expiry Date:[ \t]*(\S+)/m)),
        statuses: fields(all(text, /^Domain Status:[ \t]*(\S+)/gm)),
        nameservers: hosts(all(text, /^Name Server:[ \t]*(\S+)/gm)),
        dnssec: dnssec === undefined ? null : dnssec !== 'unsigned',
      });
    }
    if (/^Domain not found\.[ \t]*$/m.test(text)) return noRecord(ctx, null, 'answered "Domain not found."');
    return UNRECOGNIZED(ctx.spec.host);
  },
};

/**
 * JPRS (.jp), queried with the /e suffix for English labels. Free: "No match!!". Registered:
 * "[Domain Name]" line (prefixed "a." for organizational second-level names). Throttle text from
 * https://jprs.jp/about/dom-search/jprs-whois/whois-guide-notes.html.
 */
const jprs: WhoisParser = {
  id: 'jprs',
  version: 'whois-jprs/1',
  classify(text, ctx) {
    if (/^Cannot process your search request\./m.test(text)) return rateLimited(ctx, 'JPRS access restriction');
    const nameLine = first(text, /^(?:[a-z]\.[ \t]*)?\[Domain Name\][ \t]+(\S+)[ \t]*$/im);
    if (nameLine) {
      const name = asciiName(nameLine);
      if (!name) return UNRECOGNIZED(ctx.spec.host);
      if (name !== ctx.domain.ascii) return mismatch(ctx, name);
      const state = first(text, /^(?:[a-z]\.[ \t]*)?\[(?:Status|State)\][ \t]+(\S.*)$/im);
      if (!state) return INCOMPLETE(ctx.spec.host, 'a [Status] or [State] line');
      const expires = first(text, /\[Expires on\][ \t]+(\S+)/i) ?? first(text, /\[State\][ \t]+\S+[ \t]+\((\d{4}\/\d{2}\/\d{2})\)/i);
      const eligibility: Eligibility =
        state && /^reserved\b/i.test(state)
          ? { status: 'reserved', source: `JPRS WHOIS state "${sanitizeField(state, 60)}"`, scope: '.jp registry state for this name' }
          : UNKNOWN_ELIGIBILITY;
      return registered(
        ctx,
        name,
        {
          registrar: null,
          createdAt: localToIso(first(text, /\[(?:Created on|Registered Date)\][ \t]+(\S+)/i), '+09:00'),
          updatedAt: localToIso(first(text, /\[Last Updated?\][ \t]+(\S+(?: \S+)?)/i), '+09:00'),
          expiresAt: localToIso(expires, '+09:00'),
          statuses: fields([state]),
          nameservers: hosts(all(text, /^(?:[a-z]\.[ \t]*)?\[Name Server\][ \t]+(\S+)/gim)),
          dnssec: null,
        },
        eligibility,
      );
    }
    if (/^No match!![ \t]*$/m.test(text)) return noRecord(ctx, null, 'answered "No match!!"');
    return UNRECOGNIZED(ctx.spec.host);
  },
};

/**
 * CNNIC (.cn). Free: "No matching record." Registered: "Domain Name:" record with Beijing-time
 * dates. Throttle text "Queried interval is too short." is taken from third-party relays of CNNIC
 * replies (not CNNIC documentation).
 */
const cnnic: WhoisParser = {
  id: 'cnnic',
  version: 'whois-cnnic/1',
  classify(text, ctx) {
    if (/^Queried interval is too short\.?[ \t]*$/m.test(text)) return rateLimited(ctx, 'query interval too short');
    const nameLine = first(text, /^Domain Name:[ \t]*(\S+)[ \t]*$/m);
    if (nameLine) {
      const name = asciiName(nameLine);
      if (!name) return UNRECOGNIZED(ctx.spec.host);
      if (name !== ctx.domain.ascii) return mismatch(ctx, name);
      if (!/^Registration Time:[ \t]*\S/m.test(text) || !/^Expiration Time:[ \t]*\S/m.test(text)) {
        return INCOMPLETE(ctx.spec.host, 'Registration Time and Expiration Time lines');
      }
      const dnssec = first(text, /^DNSSEC:[ \t]*(\S+)/m)?.toLowerCase();
      return registered(ctx, name, {
        registrar: sanitizeField(first(text, /^Sponsoring Registrar:[ \t]*(.+)$/m)),
        createdAt: localToIso(first(text, /^Registration Time:[ \t]*(.+)$/m), '+08:00'),
        updatedAt: null,
        expiresAt: localToIso(first(text, /^Expiration Time:[ \t]*(.+)$/m), '+08:00'),
        statuses: fields(all(text, /^Domain Status:[ \t]*(\S+)/gm)),
        nameservers: hosts(all(text, /^Name Server:[ \t]*(\S+)/gm)),
        dnssec: dnssec === undefined ? null : dnssec !== 'unsigned',
      });
    }
    if (/^No matching record\.?[ \t]*$/m.test(text)) return noRecord(ctx, null, 'answered "No matching record."');
    return UNRECOGNIZED(ctx.spec.host);
  },
};

/**
 * EURid (.eu). Free: "Status: AVAILABLE" under the matching "Domain:" line. Registered replies have
 * no Status line and a "Registrar:" block. Any other status is inconclusive. Throttle text
 * "Excessive querying, grace period of N seconds" (EURid and DNS Belgium; older community reports).
 */
const eurid: WhoisParser = {
  id: 'eurid',
  version: 'whois-eurid/1',
  classify(text, ctx) {
    const grace = /^%?[ \t]*Excessive querying, grace period of (\d+) seconds/im.exec(text);
    if (grace) {
      const seconds = Math.min(Math.max(Number(grace[1]), ctx.spec.rateLimitCooldownSeconds), 86_400);
      return rateLimited(ctx, `grace period of ${grace[1]} seconds`, seconds);
    }
    const name = asciiName(first(text, /^Domain:[ \t]*(\S+)[ \t]*$/m));
    if (!name) return UNRECOGNIZED(ctx.spec.host);
    if (name !== ctx.domain.ascii) return mismatch(ctx, name);
    const status = first(text, /^Status:[ \t]*(.+?)[ \t]*$/m);
    if (status !== undefined) {
      if (status.toUpperCase() === 'AVAILABLE') return noRecord(ctx, name, 'reports status AVAILABLE (no registration)');
      return unresolved('inconclusive', 'unknown_status', `${ctx.spec.host} reported status "${sanitizeField(status, 40)}"`, { matchedName: name });
    }
    const registrar = first(text, /^Registrar:[ \t]*\n[ \t]+Name:[ \t]*(.+)$/m);
    if (!registrar) return UNRECOGNIZED(ctx.spec.host);
    const nsBlock = /^Name servers:[ \t]*\n((?:[ \t]+\S.*\n?)+)/m.exec(text)?.[1] ?? '';
    return registered(ctx, name, {
      registrar: sanitizeField(registrar),
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      statuses: [],
      nameservers: hosts(nsBlock.split('\n').map((line) => line.trim().split(/[ \t]+/)[0] ?? '')),
      dnssec: null,
    });
  },
};

export const WHOIS_PARSERS: Record<string, WhoisParser> = Object.fromEntries(
  [denic, nicIo, jprs, cnnic, eurid].map((parser) => [parser.id, parser]),
);
