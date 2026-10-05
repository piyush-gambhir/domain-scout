import type { Eligibility } from '@domain-scout/contracts';
import { UNKNOWN_ELIGIBILITY, unresolved } from '../classification.js';
import { sanitizeField, toIso } from '../sanitize.js';
import { CCTLD_WHOIS_PARSERS } from './cctld-classifiers.js';
import {
  INCOMPLETE,
  UNRECOGNIZED,
  all,
  asciiName,
  conflicting,
  fields,
  first,
  hosts,
  localToIso,
  mismatch,
  names,
  noRecord,
  rateLimited,
  registered,
  values,
  type WhoisParser,
} from './whois-common.js';

export { classifyWhois, type WhoisContext, type WhoisParser } from './whois-common.js';

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
    const identities = new Set([...names(text, /^Domain-Ace:(.*)$/gm), ...names(text, /^Domain:(.*)$/gm)]);
    if (identities.size > 1 || values(text, /^Status:(.*)$/gm).length > 1) return conflicting(ctx, 'domain or status lines');
    const name = asciiName(first(text, /^Domain-Ace:[ \t]*(\S+)[ \t]*$/m)) ?? asciiName(first(text, /^Domain:[ \t]*(.+?)[ \t]*$/m));
    const status = first(text, /^Status:[ \t]*(\S+)[ \t]*$/m)?.toLowerCase();
    if (!name || !status) return UNRECOGNIZED(ctx.spec.host);
    if (name !== ctx.domain.ascii) return mismatch(ctx, name);

    if ((status === 'free' || status === 'invalid') && /^(?:Nserver|Dnskey|Changed):/m.test(text)) return conflicting(ctx, `status ${status} and registration lines`);
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
    const jprsRecord = /^(?:[a-z]\.[ \t]*)?\[(?:Domain Name|Status|State|Name Server|Created on|Registered Date|Expires on)\]/im.test(text);
    if (names(text, /^(?:[a-z]\.[ \t]*)?\[Domain Name\](.*)$/gim).length > 1 || (jprsRecord && /^No match!![ \t]*$/m.test(text))) {
      return conflicting(ctx, 'domain lines or not-found text and a record');
    }
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
    const cnnicRecord = /^(?:Domain Name|ROID|Domain Status|Registrant|Sponsoring Registrar|Name Server|Registration Time|Expiration Time|DNSSEC):/m.test(text);
    if (names(text, /^Domain Name:(.*)$/gm).length > 1 || (cnnicRecord && /^No matching record\.?[ \t]*$/m.test(text))) {
      return conflicting(ctx, 'domain lines or not-found text and a record');
    }
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
    if (names(text, /^Domain:(.*)$/gm).length > 1 || values(text, /^Status:(.*)$/gm).length > 1) {
      return conflicting(ctx, 'domain or status lines');
    }
    const name = asciiName(first(text, /^Domain:[ \t]*(\S+)[ \t]*$/m));
    if (!name) return UNRECOGNIZED(ctx.spec.host);
    if (name !== ctx.domain.ascii) return mismatch(ctx, name);
    const status = first(text, /^Status:[ \t]*(.+?)[ \t]*$/m);
    if (status !== undefined) {
      if (/^(?:Registrar|Name servers|Registrant|Technical|Keys):/m.test(text)) return conflicting(ctx, 'a status line and registration blocks');
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
  [denic, jprs, cnnic, eurid, ...CCTLD_WHOIS_PARSERS].map((parser) => [parser.id, parser]),
);
