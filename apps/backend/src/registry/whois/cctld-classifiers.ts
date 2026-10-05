import type { Eligibility } from '@domain-scout/contracts';
import { unresolved, type Classification } from '../classification.js';
import { sanitizeField, toIso } from '../sanitize.js';
import {
  INCOMPLETE,
  NO_DETAILS,
  UNRECOGNIZED,
  all,
  asciiName,
  block,
  blockedBy,
  conflicting,
  dateOnly,
  dayMonthYear,
  fields,
  first,
  hosts,
  mismatch,
  names,
  noRecord,
  noRecordStated,
  rateLimited,
  registered,
  registryInvalid,
  unknownStatus,
  values,
  type WhoisContext,
  type WhoisParser,
} from './whois-common.js';

/**
 * Registry-specific WHOIS classifiers for ccTLD registries without a usable public RDAP service.
 * Sources per registry are cited below and in data/registry/whois-routing.json; reply shapes come
 * from registry documentation where it exists and otherwise from dated reference captures. Every
 * classifier requires its registry's exact negative text and a complete record shape, and treats a
 * reply that names two domains, states two statuses or carries both a negative and a record as
 * conflicting; anything else is inconclusive.
 */

function stated(status: Eligibility['status'], source: string, scope: string): Eligibility {
  return { status, source, scope };
}

/**
 * A negative reply that echoes the queried name, given the distinct echoed names (see names()):
 * no_record when it echoes exactly the request, otherwise a mismatch or conflict.
 */
function echoedNegative(ctx: WhoisContext, echoes: string[], detail: string): Classification {
  if (echoes.length > 1) return conflicting(ctx, 'names in its not-found reply');
  const name = echoes[0] ?? '';
  if (name !== ctx.domain.ascii) return mismatch(ctx, name || 'an unreadable name');
  return noRecord(ctx, name, detail);
}

/** The one name a reply's identity lines agree on, or the classification for a reply without one. */
function soleName(ctx: WhoisContext, found: string[]): { name: string } | { result: Classification } {
  if (found.length > 1) return { result: conflicting(ctx, 'domain names') };
  const name = found[0];
  if (!name) return { result: UNRECOGNIZED(ctx.spec.host) };
  if (name !== ctx.domain.ascii) return { result: mismatch(ctx, name) };
  return { name };
}

/** The one value a field states, null when absent, or a conflict when the reply states several. */
function soleValue(ctx: WhoisContext, text: string, pattern: RegExp, what: string): { value: string | null } | { result: Classification } {
  const found = all(text, pattern);
  if (values(text, pattern).length > 1) return { result: conflicting(ctx, what) };
  return { value: found[0] ?? null };
}

interface IcannStyleOptions {
  id: string;
  version: string;
  /** The registry's exact negative reply: the distinct names it echoes ([] when it echoes none), or null. */
  notFound(text: string): string[] | null;
  /** Lines (besides "Domain Name:") a complete registered record carries. */
  required: { pattern: RegExp; label: string };
}

/**
 * Registries that print the ICANN RDDS key/value layout ("Domain Name:", "Creation Date:",
 * "Registry Expiry Date:", "Name Server:") and differ only in their negative reply.
 */
function icannStyle(options: IcannStyleOptions): WhoisParser {
  return {
    id: options.id,
    version: options.version,
    classify(text, ctx) {
      const negative = options.notFound(text);
      if (negative !== null && ICANN_RECORD.test(text)) return conflicting(ctx, 'not-found text and record lines');
      if (negative !== null) {
        if (negative.length === 0) return noRecord(ctx, null, 'answered with its "not found" reply');
        return echoedNegative(ctx, negative, 'answered with its "not found" reply');
      }
      return icannRecord(text, ctx, options.required);
    },
  };
}

/** Registered record in the ICANN layout, checked against the request and for completeness. */
function icannRecord(text: string, ctx: WhoisContext, required: IcannStyleOptions['required']): Classification {
  const identity = soleName(ctx, names(text, /^Domain Name:(.*)$/gim));
  if ('result' in identity) return identity.result;
  const name = identity.name;
  if (!/^Creation Date:[ \t]*\S/m.test(text) || !required.pattern.test(text)) {
    return INCOMPLETE(ctx.spec.host, `Creation Date and ${required.label} lines`);
  }
  const dnssec = first(text, /^DNSSEC:[ \t]*(\S+)/m)?.toLowerCase();
  return registered(ctx, name, {
    registrar: sanitizeField(first(text, /^Registrar:[ \t]*(\S.*)$/m)),
    createdAt: toIso(first(text, /^Creation Date:[ \t]*(\S+)/m)),
    updatedAt: toIso(first(text, /^Updated Date:[ \t]*(\S+)/m)),
    expiresAt: toIso(first(text, /^(?:Registry Expiry Date|Registrar Registration Expiration Date):[ \t]*(\S+)/m)),
    statuses: fields(all(text, /^Domain Status:[ \t]*(\S+)/gm)),
    nameservers: hosts(all(text, /^Name Server:[ \t]*(\S+)/gm)),
    dnssec: dnssec === undefined ? null : dnssec !== 'unsigned',
  });
}

/** Distinct names echoed by a negative line (`pattern` needs the g and m flags), or null without one. */
function echoes(text: string, pattern: RegExp): string[] | null {
  const found = names(text, pattern);
  return found.length > 0 ? found : null;
}

/** Lines of an ICANN-layout registration record; none may appear next to a negative reply. */
const ICANN_RECORD = /^(?:Domain Name|Registry Domain ID|Creation Date|Updated Date|Registry Expiry Date|Registrar Registration Expiration Date|Registrar|Domain Status|Name Server|DNSSEC):/im;

const REGISTRY_DOMAIN_ID = { pattern: /^(?:Registry Domain ID|Registrar):[ \t]*\S/m, label: 'Registry Domain ID or Registrar' };

/**
 * Identity Digital back end (.io, .sh, .vc, .me). Free: "Domain not found." (2026 captures of
 * whois.nic.io, whois.nic.sh, whois.nic.me and whois.identitydigital.services). Identity Digital
 * documents a per-IP limit but no throttle text, and its terms mention throttling, so no loose
 * wording is ever treated as a throttle signal.
 */
const identityDigital = icannStyle({
  id: 'identity-digital',
  version: 'whois-identity-digital/1',
  notFound: (text) => (/^Domain not found\.[ \t]*$/m.test(text) ? [] : null),
  required: REGISTRY_DOMAIN_ID,
});

/** CentralNic platform (.la, .gl). Free: "The queried object does not exist: DOMAIN NOT FOUND". */
const centralNic = icannStyle({
  id: 'centralnic',
  version: 'whois-centralnic/1',
  notFound: (text) => (/^The queried object does not exist: DOMAIN NOT FOUND[ \t]*$/m.test(text) ? [] : null),
  required: REGISTRY_DOMAIN_ID,
});

/** Global Domains International (.ws). Free: "The queried object does not exist: <name>." */
const websiteWs = icannStyle({
  id: 'website-ws',
  version: 'whois-website-ws/1',
  notFound: (text) => echoes(text, /^The queried object does not exist:(.*)$/gm),
  required: { pattern: /^Registrar:[ \t]*\S/m, label: 'Registrar' },
});

/** CIRA Fury platform of IE Domain Registry (.ie) and InternetNZ (.nz). Free: "Not found: <name>". */
const furyNotFound = (text: string) => echoes(text, /^Not found:(.*)$/gm);
const weAreIe = icannStyle({ id: 'weare-ie', version: 'whois-weare-ie/1', notFound: furyNotFound, required: REGISTRY_DOMAIN_ID });
const internetNz = icannStyle({
  id: 'internetnz',
  version: 'whois-internetnz/1',
  notFound: furyNotFound,
  required: { pattern: /^Registrar:[ \t]*\S/m, label: 'Registrar' },
});

/** .us (Registry Services LLC). Free: "No Data Found"; the registry notes that this is not availability. */
const usRegistry = icannStyle({
  id: 'us-registry',
  version: 'whois-us-registry/1',
  notFound: (text) => (/^No Data Found[ \t]*$/m.test(text) ? [] : null),
  required: REGISTRY_DOMAIN_ID,
});

/** CARNET (.hr). Free: "%ERROR: No entries found" (lower-case "no" in older replies). */
const carnet = icannStyle({
  id: 'carnet',
  version: 'whois-carnet/1',
  notFound: (text) => (/^%ERROR: No entries found[ \t]*$/im.test(text) ? [] : null),
  required: { pattern: /^Registrar Registration Expiration Date:[ \t]*\S/m, label: 'Registrar Registration Expiration Date' },
});

/** ZARC (co.za, org.za, net.za, web.za). Free: "Available", blank lines, then "No information was found matching that query." */
const zarc = icannStyle({
  id: 'zarc',
  version: 'whois-zarc/1',
  notFound: (text) => (/^Available[ \t]*\n(?:[ \t]*\n)*No information was found matching that query\.[ \t]*$/m.test(text) ? [] : null),
  required: REGISTRY_DOMAIN_ID,
});

/**
 * DNS Belgium (.be). Status values and return codes from
 * https://docs.dnsbelgium.be/be/general/whoisanddas.html: AVAILABLE, NOT AVAILABLE (the doc's
 * example also shows REGISTERED), NOT ALLOWED; -2 excessive querying (over 100 queries per hour),
 * -3 IP address blocked for one hour, -1 internal error.
 */
const dnsBelgium: WhoisParser = {
  id: 'dns-belgium',
  version: 'whois-dns-belgium/1',
  classify(text, ctx) {
    if (/^%?[ \t]*-2:[ \t]*Excessive querying/m.test(text)) return rateLimited(ctx, 'DNS Belgium return code -2 (excessive querying)');
    if (/^%?[ \t]*-3:[ \t]*IP address blocked/m.test(text)) return blockedBy(ctx, 'DNS Belgium return code -3 (IP address blocked)', 3600);
    if (/^%?[ \t]*-1:[ \t]*Internal (?:server|system) error/m.test(text)) {
      return unresolved('inconclusive', 'registry_error', `${ctx.spec.host} reported an internal error (return code -1)`, { retryable: true });
    }
    // For IDNs the Domain line prints the U-label and A-label the A-label; both must name one domain.
    const identity = soleName(ctx, [...new Set([...names(text, /^A-label:(.*)$/gm), ...names(text, /^Domain:(.*)$/gm)])]);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const stated_ = soleValue(ctx, text, /^Status:(.*)$/gm, 'Status lines');
    if ('result' in stated_) return stated_.result;
    const status = stated_.value;
    if (!status) return UNRECOGNIZED(ctx.spec.host);
    const upper = status.toUpperCase();
    if ((upper === 'AVAILABLE' || upper === 'NOT ALLOWED') && /^(?:Registered|Registrant|Registrar|Nameservers|Keys|Flags):/m.test(text)) {
      return conflicting(ctx, `status ${upper} and registration lines`);
    }
    if (upper === 'AVAILABLE') return noRecord(ctx, name, 'reports status AVAILABLE');
    if (upper === 'NOT ALLOWED') {
      return registryInvalid(ctx, name, 'reports status NOT ALLOWED: not a valid .be domain name', 'DNS Belgium WHOIS status "NOT ALLOWED" (https://docs.dnsbelgium.be/be/general/whoisanddas.html)');
    }
    if (upper !== 'NOT AVAILABLE' && upper !== 'REGISTERED') return unknownStatus(ctx, status, name);
    const since = /^Registered:[ \t]*\w{3} (\w{3}) (\d{1,2}) (\d{4})/m.exec(text);
    return registered(ctx, name, {
      ...NO_DETAILS,
      registrar: sanitizeField(first(text, /^Registrar:[ \t]*\n[ \t]+Name:[ \t]*(\S.*)$/m)),
      createdAt: since ? dayMonthYear(since[2]!, since[1]!, since[3]!) : null,
      statuses: fields([status, ...block(text, /^Flags:[ \t]*$/m)]),
      nameservers: hosts(block(text, /^Nameservers:[ \t]*$/m)),
    });
  },
};

/**
 * Internetstiftelsen (.se). States from the WHOIS service description (December 2025,
 * https://internetstiftelsen.se/app/uploads/2025/12/internetstiftelsen-service-description-whois-protocol.pdf):
 * active, expired and deactivated are registrations; quarantine is deregistered and not yet
 * released; system is reserved or blocked by the registry. Free: `domain "<name>" not found.`
 */
const internetstiftelsen: WhoisParser = {
  id: 'internetstiftelsen',
  version: 'whois-internetstiftelsen/1',
  classify(text, ctx) {
    const missing = echoes(text, /^(?:domain )?"(.*)" not found\.[ \t]*$/gm);
    const recordLines = /^(?:domain|state|holder|created|modified|expires|nserver|registrar|status):/m.test(text);
    if (missing && recordLines) return conflicting(ctx, 'not-found text and record lines');
    if (missing) return echoedNegative(ctx, missing, 'answered that the name was not found');
    const identity = soleName(ctx, names(text, /^domain:(.*)$/gm));
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const stateLine = soleValue(ctx, text, /^state:(.*)$/gm, 'state lines');
    if ('result' in stateLine) return stateLine.result;
    const state = stateLine.value?.toLowerCase();
    if (!state) return UNRECOGNIZED(ctx.spec.host);
    if (state === 'quarantine') {
      return noRecordStated(ctx, name, 'reports state quarantine (deregistered, not yet released)', stated('restricted', 'Internetstiftelsen WHOIS state "quarantine"', 'Not registrable until the registry releases it (date_to_release)'));
    }
    if (state === 'system') {
      const reason = sanitizeField(first(text, /^reason:[ \t]*(\S.*)$/m), 80);
      return noRecordStated(ctx, name, 'reports state system (reserved or blocked by the registry)', stated('reserved', `Internetstiftelsen WHOIS state "system"${reason ? `, reason "${reason}"` : ''}`, '.se registry reservation or block for this name'));
    }
    if (state !== 'active' && state !== 'expired' && state !== 'deactivated') return unknownStatus(ctx, state, name);
    if (!/^created:[ \t]*\S/m.test(text)) return INCOMPLETE(ctx.spec.host, 'a created line');
    const dnssec = first(text, /^dnssec:[ \t]*(\S.*)$/m)?.toLowerCase();
    return registered(ctx, name, {
      registrar: sanitizeField(first(text, /^registrar:[ \t]*(\S.*)$/m)),
      createdAt: dateOnly(first(text, /^created:[ \t]*(\S+)/m)),
      updatedAt: dateOnly(first(text, /^modified:[ \t]*(\S+)/m)),
      expiresAt: dateOnly(first(text, /^expires:[ \t]*(\S+)/m)),
      statuses: fields([state, ...all(text, /^status:[ \t]*(\S+)/gm)]),
      nameservers: hosts(all(text, /^nserver:[ \t]*(\S+)/gm)),
      dnssec: dnssec === undefined ? null : dnssec.startsWith('signed'),
    });
  },
};

/**
 * Punktum dk (.dk). Record layout and status values (Active, Deactivated, Reserved, Offered to
 * waiting list) from the official specification v6.3.1,
 * https://github.com/Punktum-dk/whois-service-specification. Free: "No entries found for the
 * selected source." (reference capture, server version 6.1.1; not in the specification).
 */
const punktum: WhoisParser = {
  id: 'punktum',
  version: 'whois-punktum/1',
  classify(text, ctx) {
    const missing = /^No entries found for the selected source\.[ \t]*$/m.test(text);
    if (missing && /^(?:Domain|DNS|Registered|Expires|Registrar|Status|Hostname):/m.test(text)) return conflicting(ctx, 'not-found text and record lines');
    if (missing) return noRecord(ctx, null, 'answered "No entries found for the selected source."');
    // Domain prints the U-label for IDNs and DNS the A-label; both must name one domain.
    const identity = soleName(ctx, [...new Set([...names(text, /^DNS:(.*)$/gm), ...names(text, /^Domain:(.*)$/gm)])]);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const stated_ = soleValue(ctx, text, /^Status:(.*)$/gm, 'Status lines');
    if ('result' in stated_) return stated_.result;
    const status = stated_.value;
    if (!status) return UNRECOGNIZED(ctx.spec.host);
    const lower = status.toLowerCase();
    if (lower === 'offered to waiting list') {
      return noRecordStated(ctx, name, 'reports status "Offered to waiting list" (not registered)', stated('restricted', 'Punktum dk WHOIS status "Offered to waiting list"', 'Offered to the first waiting-list position for up to 14 days'));
    }
    if (lower !== 'active' && lower !== 'deactivated' && lower !== 'reserved') return unknownStatus(ctx, status, name);
    if (!/^Registered:[ \t]*\d{4}-\d{2}-\d{2}/m.test(text)) return INCOMPLETE(ctx.spec.host, 'a Registered date');
    const dnssec = first(text, /^DNSSEC:[ \t]*(\S.*)$/m)?.toLowerCase();
    return registered(ctx, name, {
      registrar: sanitizeField(first(text, /^Registrar:[ \t]*(\S.*)$/m)),
      createdAt: dateOnly(first(text, /^Registered:[ \t]*(\S+)/m)),
      updatedAt: null,
      expiresAt: dateOnly(first(text, /^Expires:[ \t]*(\S+)/m)),
      statuses: fields([status]),
      nameservers: hosts(all(text, /^Hostname:[ \t]*(\S+)/gm)),
      dnssec: dnssec === undefined ? null : dnssec.startsWith('signed'),
    });
  },
};

/** DNS.PT (.pt). Free: "<name> - No Match"; registered records carry "Domain Status: Registered". */
const dnsPt: WhoisParser = {
  id: 'dns-pt',
  version: 'whois-dns-pt/1',
  classify(text, ctx) {
    const missing = echoes(text, /^(.*) - No Match[ \t]*$/gim);
    if (missing && /^(?:Domain|Domain Status|Creation Date|Expiration Date|Name Server|Owner Name):/m.test(text)) return conflicting(ctx, 'not-found text and record lines');
    if (missing) return echoedNegative(ctx, missing, 'answered "No Match"');
    const identity = soleName(ctx, names(text, /^Domain:(.*)$/gm));
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const stated_ = soleValue(ctx, text, /^Domain Status:(.*)$/gm, 'Domain Status lines');
    if ('result' in stated_) return stated_.result;
    const status = stated_.value;
    if (!status) return UNRECOGNIZED(ctx.spec.host);
    if (status.toLowerCase() !== 'registered') return unknownStatus(ctx, status, name);
    if (!/^Creation Date:[ \t]*\S/m.test(text)) return INCOMPLETE(ctx.spec.host, 'a Creation Date line');
    return registered(ctx, name, {
      ...NO_DETAILS,
      createdAt: dateOnly(first(text, /^Creation Date:[ \t]*(\S+)/m)),
      expiresAt: dateOnly(first(text, /^Expiration Date:[ \t]*(\S+)/m)),
      statuses: fields([status]),
      nameservers: hosts(all(text, /^Name Server:[ \t]*(\S+)/gm)),
    });
  },
};

/** NIC Mexico (.mx and its second-level zones). Free: "No_Se_Encontro_El_Objeto/Object_Not_Found". */
const nicMexico: WhoisParser = {
  id: 'nic-mexico',
  version: 'whois-nic-mexico/1',
  classify(text, ctx) {
    const found = names(text, /^Domain Name:(.*)$/gm);
    const missing = /^No_Se_Encontro_El_Objeto\/Object_Not_Found[ \t]*$/m.test(text);
    if (missing && (found.length > 0 || /^(?:Created On|Expiration Date|Last Updated On|Registrar|Name Servers):|^[ \t]+DNS:/m.test(text))) {
      return conflicting(ctx, 'not-found text and record lines');
    }
    if (missing) return noRecord(ctx, null, 'answered "No_Se_Encontro_El_Objeto/Object_Not_Found"');
    const identity = soleName(ctx, found);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    if (!/^Created On:[ \t]*\S/m.test(text) || !/^Expiration Date:[ \t]*\S/m.test(text)) {
      return INCOMPLETE(ctx.spec.host, 'Created On and Expiration Date lines');
    }
    return registered(ctx, name, {
      ...NO_DETAILS,
      registrar: sanitizeField(first(text, /^Registrar:[ \t]*(\S.*)$/m)),
      createdAt: dateOnly(first(text, /^Created On:[ \t]*(\S+)/m)),
      updatedAt: dateOnly(first(text, /^Last Updated On:[ \t]*(\S+)/m)),
      expiresAt: dateOnly(first(text, /^Expiration Date:[ \t]*(\S+)/m)),
      nameservers: hosts(all(text, /^[ \t]+DNS:[ \t]*(\S+)/gm)),
    });
  },
};

/**
 * CIDR, the Island Networks back end for .gg and .je. Free: the whole reply is "NOT FOUND"; the terms
 * (https://www.channelisles.net/legal/whoisterms) say names the registry does not operate or that
 * cannot be registered also give no valid result, so no_record is not eligibility.
 */
const channelIsles: WhoisParser = {
  id: 'channel-isles',
  version: 'whois-channel-isles/1',
  classify(text, ctx) {
    if (text.trim() === 'NOT FOUND') return noRecord(ctx, null, 'answered "NOT FOUND"');
    if ((text.match(/^Domain:[ \t]*$/gm) ?? []).length > 1) return conflicting(ctx, 'Domain blocks');
    const identity = soleName(ctx, block(text, /^Domain:[ \t]*$/m).map((value) => asciiName(value) ?? ''));
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const statuses = block(text, /^Domain Status:[ \t]*$/m);
    if (statuses.length === 0 || block(text, /^Registration status:[ \t]*$/m).length === 0) return INCOMPLETE(ctx.spec.host, 'Domain Status and Registration status blocks');
    const since = /^[ \t]+Registered on (\d{1,2})(?:st|nd|rd|th) (\w+) (\d{4})/m.exec(text);
    return registered(ctx, name, {
      ...NO_DETAILS,
      registrar: sanitizeField(block(text, /^Registrar:[ \t]*$/m)[0]),
      createdAt: since ? dayMonthYear(since[1]!, since[2]!, since[3]!) : null,
      statuses: fields(statuses),
      nameservers: hosts(block(text, /^Name servers:[ \t]*$/m)),
    });
  },
};

/** AM NIC (.am). Free: "No match" under the "%AM TLD whois server" banner. */
const amnic: WhoisParser = {
  id: 'amnic',
  version: 'whois-amnic/1',
  classify(text, ctx) {
    const banner = /^%[ \t]*AM TLD whois server/m.test(text);
    const found = names(text, /^[ \t]*Domain name:(.*)$/gm);
    const missing = /^No match[ \t]*$/m.test(text);
    if (missing && (found.length > 0 || /^[ \t]*(?:Status|Registrar|Registered|Expires|DNS servers):/m.test(text))) return conflicting(ctx, 'not-found text and record lines');
    if (missing && banner) return noRecord(ctx, null, 'answered "No match"');
    const identity = soleName(ctx, found);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const stated_ = soleValue(ctx, text, /^[ \t]*Status:(.*)$/gm, 'Status lines');
    if ('result' in stated_) return stated_.result;
    const status = stated_.value;
    if (!status || !/^[ \t]*Registered:[ \t]*\d{4}-/m.test(text)) return INCOMPLETE(ctx.spec.host, 'Status and Registered lines');
    return registered(ctx, name, {
      ...NO_DETAILS,
      registrar: sanitizeField(first(text, /^[ \t]*Registrar:[ \t]*(\S.*)$/m)),
      createdAt: dateOnly(first(text, /^[ \t]*Registered:[ \t]*(\S+)/m)),
      updatedAt: dateOnly(first(text, /^[ \t]*Last modified:[ \t]*(\S+)/m)),
      expiresAt: dateOnly(first(text, /^[ \t]*Expires:[ \t]*(\S+)/m)),
      statuses: fields([status]),
      nameservers: hosts(block(text, /^[ \t]*DNS servers:[ \t]*$/m)),
    });
  },
};

/**
 * Domicilium for the Isle of Man Government (.im). Free: "The domain <name> was not found." (the
 * same reply also carries a "Domain Name:" line, so the negative text is checked first).
 */
const nicIm: WhoisParser = {
  id: 'nic-im',
  version: 'whois-nic-im/1',
  classify(text, ctx) {
    const missing = echoes(text, /^The domain (.*) was not found\.[ \t]*$/gm);
    const found = names(text, /^Domain Name:(.*)$/gm);
    if (missing) {
      // The not-found reply repeats the name on a "Domain Name:" line; it must be the same name and nothing else.
      const echoedNames = [...new Set([...missing, ...found])];
      if (/^(?:Domain Details|Domain Managers|Domain Owners|Expiry Date:|Name Server:)/m.test(text)) return conflicting(ctx, 'not-found text and record lines');
      return echoedNegative(ctx, echoedNames, 'answered that the domain was not found');
    }
    const identity = soleName(ctx, found);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    if (!/^Domain Details[ \t]*$/m.test(text) || !/^Expiry Date:[ \t]*\S/m.test(text)) return INCOMPLETE(ctx.spec.host, 'Domain Details and Expiry Date lines');
    return registered(ctx, name, {
      ...NO_DETAILS,
      expiresAt: dateOnly(first(text, /^Expiry Date:[ \t]*(\S+)/m)),
      nameservers: hosts(all(text, /^Name Server:[ \t]*(\S+)/gm)),
    });
  },
};

/**
 * RESTENA DNS-LU (.lu). domaintype values FREE, ACTIVE and RESERVED from
 * https://dns.lu/en/domains/apiprotocols. Free: "% No such domain" after "% WHOIS <name>".
 * Throttle: "%% Maximum query rate reached" (the documented wait doubles with each excess query).
 */
const dnsLu: WhoisParser = {
  id: 'dns-lu',
  version: 'whois-dns-lu/1',
  classify(text, ctx) {
    if (/^%% Maximum query rate reached/m.test(text)) return rateLimited(ctx, 'DNS-LU maximum query rate reached');
    // Query echoes are "% WHOIS <name>" lines whose first word contains a dot; banner prose ("% WHOIS database ...") does not.
    const queried = names(text, /^% WHOIS[ \t]+(\S*\.\S*.*)$/gm);
    if (/^% No such domain[ \t]*$/m.test(text)) {
      if (/^(?:domainname|domaintype|nserver|ownertype|registrar-name|registered):/m.test(text)) return conflicting(ctx, 'not-found text and record lines');
      if (queried.length === 0) return noRecord(ctx, null, 'answered "No such domain"');
      return echoedNegative(ctx, queried, 'answered "No such domain"');
    }
    const identity = soleName(ctx, [...new Set([...queried, ...names(text, /^domainname:(.*)$/gm)])]);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const typeLine = soleValue(ctx, text, /^domaintype:(.*)$/gm, 'domaintype lines');
    if ('result' in typeLine) return typeLine.result;
    const type = typeLine.value;
    if (!type) return UNRECOGNIZED(ctx.spec.host);
    // Documented values only: FREE, or ACTIVE / RESERVED with an optional ON HOLD or PENDING_DELETE.
    const kind = /^(FREE|ACTIVE|RESERVED)(?:[ \t]+(ON HOLD|PENDING_DELETE))?$/i.exec(type);
    if (!kind || (kind[1]!.toUpperCase() === 'FREE' && kind[2])) return unknownStatus(ctx, type, name);
    if (kind[1]!.toUpperCase() === 'FREE') {
      if (/^(?:nserver|ownertype|registrar-name|registrar-url|registered|org-name|org-country):/m.test(text)) return conflicting(ctx, 'domaintype FREE and registration lines');
      return noRecord(ctx, name, 'reports domaintype FREE');
    }
    if (kind[1]!.toUpperCase() === 'RESERVED') {
      return noRecordStated(ctx, name, `reports domaintype ${sanitizeField(type, 40)}`, stated('reserved', `DNS-LU WHOIS domaintype "${sanitizeField(type, 40)}"`, '.lu registry reservation for this name'));
    }
    return registered(ctx, name, {
      ...NO_DETAILS,
      registrar: sanitizeField(first(text, /^registrar-name:[ \t]*(\S.*)$/m)),
      createdAt: dateOnly(first(text, /^registered:[ \t]*(\S+)/m)),
      statuses: fields([type]),
      nameservers: hosts(all(text, /^nserver:[ \t]*(\S+)/gm)),
    });
  },
};

const EIS_FOOTER = /^Estonia \.ee Top Level Domain WHOIS server[ \t]*$/m;
/** Statuses of the registry's inactive template (app/models/whois_record.rb), shown for names without a registration. */
const EIS_INACTIVE = new Set(['reserved', 'blocked', 'atauction', 'pendingregistration', 'disputed', 'deletecandidate']);

/**
 * Estonian Internet Foundation (.ee). Reply texts from the registry's own server source
 * (https://github.com/internetee/whois, lib/whois_server.rb and app/views/whois_record): "Domain not
 * found", "Policy error: ..." and an inactive template (name and status only) for Reserved, Blocked,
 * AtAuction, PendingRegistration, Disputed and deleteCandidate names. Registered records carry a
 * "registered:" line. Throttling refuses the connection, which is a transport error.
 */
const eis: WhoisParser = {
  id: 'eis',
  version: 'whois-eis/1',
  classify(text, ctx) {
    if (!EIS_FOOTER.test(text)) return UNRECOGNIZED(ctx.spec.host);
    const found = names(text, /^Domain:[ \t]*\nname:(.*)$/gm);
    const message = /^(?:Domain not found|Policy error:|There was a technical issue|ERROR:)/m.test(text);
    if (message && (found.length > 0 || /^(?:Domain:|status:|registered:|expire:|nserver:)/m.test(text))) {
      return conflicting(ctx, 'an error or not-found message and record lines');
    }
    if (/^Domain not found[ \t]*$/m.test(text)) return noRecord(ctx, null, 'answered "Domain not found"');
    if (/^Policy error:/m.test(text)) {
      return registryInvalid(ctx, null, 'answered with a policy error: the name does not meet .ee registration requirements', 'EIS WHOIS policy error (https://www.internet.ee/domains/ee-domain-regulation#registration-of-domain-names)');
    }
    if (/^There was a technical issue with whois body/m.test(text)) {
      return unresolved('inconclusive', 'registry_error', `${ctx.spec.host} reported a technical issue`, { retryable: true });
    }
    if (/^ERROR:/m.test(text)) return unresolved('inconclusive', 'registry_error', `${ctx.spec.host} answered with an error`);
    const identity = soleName(ctx, found);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const statuses = all(text, /^status:(.*)$/gm);
    if (statuses.length === 0 || statuses.includes('')) return INCOMPLETE(ctx.spec.host, 'a status line');
    // The registry prints inactive states (EIS_INACTIVE) only in its template for names without a registration.
    const inactive = statuses.filter((status) => EIS_INACTIVE.has(status.toLowerCase()));
    if (/^registered:/m.test(text)) {
      if (inactive.length > 0 || !/^registered:[ \t]*\S/m.test(text)) return conflicting(ctx, 'registration lines and an inactive status');
      return registered(ctx, name, {
        registrar: sanitizeField(first(text, /^Registrar:[ \t]*\nname:[ \t]*(\S.*)$/m)),
        createdAt: eisDate(first(text, /^registered:[ \t]*(\S.*)$/m)),
        updatedAt: eisDate(first(text, /^changed:[ \t]*(\S.*)$/m)),
        expiresAt: eisDate(first(text, /^expire:[ \t]*(\S.*)$/m)),
        statuses: fields(statuses),
        nameservers: hosts(all(text, /^nserver:[ \t]*(\S+)/gm)),
        dnssec: null,
      });
    }
    if (inactive.length !== statuses.length || /^(?:expire|outzone|nserver):/m.test(text)) return conflicting(ctx, 'statuses for a name without a registration');
    const distinct = [...new Set(inactive.map((status) => status.toLowerCase()))];
    if (distinct.length > 1) return conflicting(ctx, 'inactive statuses');
    const state = inactive[0]!;
    if (distinct[0] === 'reserved') {
      return noRecordStated(ctx, name, 'reports status Reserved (not registered)', stated('reserved', 'EIS WHOIS status "Reserved"', '.ee registry reservation for this name'));
    }
    if (distinct[0] === 'deletecandidate') return unknownStatus(ctx, state, name);
    return noRecordStated(ctx, name, `reports status ${sanitizeField(state, 40)} (not registered)`, stated('restricted', `EIS WHOIS status "${sanitizeField(state, 40)}"`, '.ee registry state for this name'));
  },
};

/** "2010-07-04 04:59:06 +03:00" or "2030-12-09" from EIS records. */
function eisDate(value: string | undefined): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}:\d{2}) ([+-]\d{2}:\d{2}))?/.exec(value?.trim() ?? '');
  if (!match) return null;
  return match[2] ? toIso(`${match[1]}T${match[2]}${match[3]}`) : dateOnly(match[1]);
}

/** NIC.LV (.lv). "[Domain]" section with "Status: free" or "Status: active". Data refreshes four times a day. */
const nicLv: WhoisParser = {
  id: 'nic-lv',
  version: 'whois-nic-lv/1',
  classify(text, ctx) {
    const sections = [...text.matchAll(/^\[Domain\][ \t]*\nDomain:[ \t]*(\S+)[ \t]*\nStatus:[ \t]*(\S+)[ \t]*$/gm)];
    if (sections.length === 0) return UNRECOGNIZED(ctx.spec.host);
    if (sections.length > 1 || (text.match(/^Domain:/gm) ?? []).length > 1 || (text.match(/^Status:/gm) ?? []).length > 1) {
      return conflicting(ctx, 'Domain sections');
    }
    const [, rawName, rawStatus] = sections[0]!;
    const identity = soleName(ctx, [asciiName(rawName) ?? '']);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const status = rawStatus!.toLowerCase();
    if (status === 'free') {
      if (/^\[(?:Holder|Tech|Nservers)\]/m.test(text) || /^Nserver:/m.test(text)) return conflicting(ctx, 'status free and registration sections');
      return noRecord(ctx, name, 'reports status free');
    }
    if (status !== 'active') return unknownStatus(ctx, rawStatus!, name);
    return registered(ctx, name, { ...NO_DETAILS, statuses: fields([rawStatus!]), nameservers: hosts(all(text, /^Nserver:[ \t]*(\S+)/gm)) });
  },
};

const DOMREG_REGISTERED = new Set(['registered', 'restricteddisposal', 'restrictedrights', 'stopped']);

/**
 * DOMREG (.lt) Domain Availability Service on das.domreg.lt:4343, which the registry recommends for
 * automated checks (https://www.domreg.lt/en/faq/for-registrars/how-to-get-the-information-on-domains/;
 * port-43 WHOIS blocks an IP after 100 queries per 30 minutes). Statuses from the same page:
 * available, registered, blocked, reserved, restrictedDisposal, restrictedRights, stopped,
 * pendingCreate, pendingDelete, pendingRelease, outOfService. Only available, reserved and the
 * states of an existing registration are mapped; the rest stay inconclusive.
 */
const domregDas: WhoisParser = {
  id: 'domreg-das',
  version: 'das-domreg/1',
  classify(text, ctx) {
    const identity = soleName(ctx, names(text, /^Domain:(.*)$/gm));
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const stated_ = soleValue(ctx, text, /^Status:(.*)$/gm, 'Status lines');
    if ('result' in stated_) return stated_.result;
    const status = stated_.value;
    if (!status) return UNRECOGNIZED(ctx.spec.host);
    const lower = status.toLowerCase();
    if (lower === 'available') return noRecord(ctx, name, 'reports status available');
    if (lower === 'reserved') {
      return noRecordStated(ctx, name, 'reports status reserved', stated('reserved', 'DOMREG DAS status "reserved"', '.lt registry reservation for this name'));
    }
    if (DOMREG_REGISTERED.has(lower)) return registered(ctx, name, { ...NO_DETAILS, statuses: fields([status]) });
    return unknownStatus(ctx, status, name);
  },
};

/** SK-NIC (.sk). Free: "Domain not found."; registered records carry Created and Valid Until lines. */
const skNic: WhoisParser = {
  id: 'sk-nic',
  version: 'whois-sk-nic/1',
  classify(text, ctx) {
    const found = names(text, /^Domain:(.*)$/gm);
    const missing = /^Domain not found\.[ \t]*$/m.test(text);
    if (missing && (found.length > 0 || /^(?:Created|Valid Until|Updated|Domain Status|Nameserver|Registrar):/m.test(text))) {
      return conflicting(ctx, 'not-found text and record lines');
    }
    if (missing) return noRecord(ctx, null, 'answered "Domain not found."');
    const identity = soleName(ctx, found);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    if (!/^Created:[ \t]*\S/m.test(text) || !/^Valid Until:[ \t]*\S/m.test(text)) return INCOMPLETE(ctx.spec.host, 'Created and Valid Until lines');
    return registered(ctx, name, {
      ...NO_DETAILS,
      registrar: sanitizeField(first(text, /^Registrar:[ \t]*(\S.*)$/m)),
      createdAt: dateOnly(first(text, /^Created:[ \t]*(\S+)/m)),
      updatedAt: dateOnly(first(text, /^Updated:[ \t]*(\S+)/m)),
      expiresAt: dateOnly(first(text, /^Valid Until:[ \t]*(\S+)/m)),
      statuses: fields(all(text, /^Domain Status:[ \t]*(\S+)/gm)),
      nameservers: hosts(all(text, /^Nameserver:[ \t]*(\S+)/gm)),
    });
  },
};

/**
 * RNIDS (.rs). Free: "%ERROR:103: Domain is not registered". Every status in
 * https://www.rnids.rs/en/domain-name-status-codes belongs to an existing registration.
 */
const rnids: WhoisParser = {
  id: 'rnids',
  version: 'whois-rnids/1',
  classify(text, ctx) {
    const found = names(text, /^Domain name:(.*)$/gm);
    const error = /^%ERROR:(\d+):[ \t]*(.*)$/m.exec(text);
    if (error && (found.length > 0 || /^(?:Domain status|Registration date|Expiration date|Registrar|DNS):/m.test(text))) return conflicting(ctx, 'an error and record lines');
    if (values(text, /^%ERROR(.*)$/gm).length > 1) return conflicting(ctx, 'error lines');
    if (/^%ERROR:103: Domain is not registered[ \t]*$/m.test(text)) return noRecord(ctx, null, 'answered "%ERROR:103: Domain is not registered"');
    if (error) return unresolved('inconclusive', 'registry_error', `${ctx.spec.host} answered with error ${error[1]} ${sanitizeField(error[2]) ?? ''}`.trim());
    const identity = soleName(ctx, found);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const stated_ = soleValue(ctx, text, /^Domain status:(.*)$/gm, 'Domain status lines');
    if ('result' in stated_) return stated_.result;
    const status = stated_.value;
    if (!status || !/^Registration date:[ \t]*\S/m.test(text)) return INCOMPLETE(ctx.spec.host, 'Domain status and Registration date lines');
    const statuses = status.split(',').map((part) => part.trim().split(/[ \t]+/)[0] ?? '');
    const dnssec = first(text, /^DNSSEC signed:[ \t]*(\S+)/m)?.toLowerCase();
    return registered(ctx, name, {
      registrar: sanitizeField(first(text, /^Registrar:[ \t]*(\S.*)$/m)),
      createdAt: dateOnly(first(text, /^Registration date:[ \t]*(\S+)/m)),
      updatedAt: dateOnly(first(text, /^Modification date:[ \t]*(\S+)/m)),
      expiresAt: dateOnly(first(text, /^Expiration date:[ \t]*(\S+)/m)),
      statuses: fields(statuses),
      nameservers: hosts(all(text, /^DNS:[ \t]*(\S+)/gm)),
      dnssec: dnssec === 'yes' ? true : dnssec === 'no' ? false : null,
    });
  },
};

/** Register.BG (.bg). Both replies start "DOMAIN NAME:"; "registration status: available" or "busy, ...". */
const registerBg: WhoisParser = {
  id: 'register-bg',
  version: 'whois-register-bg/1',
  classify(text, ctx) {
    // "DOMAIN NAME: <name> (<A-label>)": every printed form must name one domain.
    const headers = [...text.matchAll(/^DOMAIN NAME:(.*)$/gm)].map((line) => /^[ \t]*(\S+)(?:[ \t]+\((\S+)\))?[ \t]*$/.exec(line[1]!));
    if (headers.some((header) => header === null)) return conflicting(ctx, 'DOMAIN NAME lines');
    const identity = soleName(ctx, [...new Set(headers.flatMap((header) => [header![1], header![2]]).filter((value) => value !== undefined).map((value) => asciiName(value) ?? ''))]);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const stated_ = soleValue(ctx, text, /^registration status:(.*)$/gm, 'registration status lines');
    if ('result' in stated_) return stated_.result;
    const status = stated_.value;
    if (!status) return UNRECOGNIZED(ctx.spec.host);
    const lower = status.toLowerCase();
    if (lower === 'available') {
      if (/^(?:NAME SERVER INFORMATION|DNSSEC):/m.test(text)) return conflicting(ctx, 'status available and registration lines');
      return noRecord(ctx, name, 'reports registration status available');
    }
    if (!/^busy\b/.test(lower)) return unknownStatus(ctx, status, name);
    const dnssec = first(text, /^DNSSEC:[ \t]*(\S+)/m)?.toLowerCase();
    const nsBlock = /^NAME SERVER INFORMATION:[ \t]*\n((?:[^\n]*\S[^\n]*\n?)*)/m.exec(text)?.[1] ?? '';
    return registered(ctx, name, {
      ...NO_DETAILS,
      statuses: fields(status.split(',').map((part) => part.trim())),
      nameservers: hosts(nsBlock.split('\n').filter((line) => !/^DNSSEC:/i.test(line)).map((line) => line.trim().split(/[ \t]+/)[0] ?? '')),
      dnssec: dnssec === 'active' ? true : dnssec === 'inactive' ? false : null,
    });
  },
};

/** ISZT / domain.hu (.hu). Free: "Nincs talalat / No match"; records carry only "domain:" and "record created:". */
const nicHu: WhoisParser = {
  id: 'nic-hu',
  version: 'whois-nic-hu/1',
  classify(text, ctx) {
    const found = names(text, /^domain:(.*)$/gm);
    const missing = /^Nincs tal[aá]lat \/ No match[ \t]*$/m.test(text);
    if (missing && (found.length > 0 || /^record created:/m.test(text))) return conflicting(ctx, 'not-found text and record lines');
    if (missing) return noRecord(ctx, null, 'answered "Nincs talalat / No match"');
    const identity = soleName(ctx, found);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const created = first(text, /^record created:[ \t]*(\S.*?)[ \t]*$/m);
    if (!created) return INCOMPLETE(ctx.spec.host, 'a record created line');
    return registered(ctx, name, { ...NO_DETAILS, createdAt: dateOnly(created.replace(/\./g, '-')) });
  },
};

const IT_REGISTERED = new Set([
  'ok',
  'inactive/dnshold',
  'pendingupdate',
  'inactive/clienthold',
  'inactive/serverhold',
  'pendingdelete/redemptionperiod',
  'pendingdelete/pendingdelete',
  'pendingtransfer',
  'autorenewperiod',
  'challenged',
  'inactive/revoked',
  'inactive/tobereassigned',
  'ok/noregistrar',
  'inactive/noregistrar',
  'inactive/notrenewed',
]);

/**
 * Registro .it (.it). Free: "Status: AVAILABLE"; "Status: UNASSIGNABLE" for geographical or reserved
 * names (Synchronous Technical Guidelines v3.2, sections 16.4 and 16.5,
 * https://www.nic.it/sites/default/files/documenti/2024/Synchronous_Technical_Guidelines_v3.2_0.pdf).
 * Registered statuses from section 2.3.1 of the same guidelines.
 */
const registroIt: WhoisParser = {
  id: 'registro-it',
  version: 'whois-registro-it/1',
  classify(text, ctx) {
    const identity = soleName(ctx, names(text, /^Domain:(.*)$/gm));
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const stated_ = soleValue(ctx, text, /^Status:(.*)$/gm, 'Status lines');
    if ('result' in stated_) return stated_.result;
    const status = stated_.value;
    if (!status) return UNRECOGNIZED(ctx.spec.host);
    const key = status.replace(/[ \t]*\/[ \t]*/g, '/').toLowerCase();
    if ((key === 'available' || key === 'unassignable') && /^(?:Signed|Created|Last Update|Expire Date|Registrant|Registrar|Nameservers)\b/m.test(text)) {
      return conflicting(ctx, `Status ${status} and registration lines`);
    }
    if (key === 'available') return noRecord(ctx, name, 'reports Status AVAILABLE');
    if (key === 'unassignable' || key === 'reserved') {
      return noRecordStated(ctx, name, `reports Status ${sanitizeField(status, 40)}`, stated('reserved', `Registro .it WHOIS Status "${sanitizeField(status, 40)}" (geographical or reserved name)`, '.it registry reservation for this name'));
    }
    if (!IT_REGISTERED.has(key)) return unknownStatus(ctx, status, name);
    if (!/^Created:[ \t]*\S/m.test(text)) return INCOMPLETE(ctx.spec.host, 'a Created line');
    const registrarAt = text.search(/^Registrar[ \t]*$/m);
    const registrar = registrarAt === -1 ? undefined : first(text.slice(registrarAt), /^[ \t]+Organization:[ \t]*(\S.*)$/m);
    const signed = first(text, /^Signed:[ \t]*(\S+)/m)?.toLowerCase();
    return registered(ctx, name, {
      registrar: sanitizeField(registrar),
      createdAt: dateOnly(first(text, /^Created:[ \t]*(\S+)/m)),
      updatedAt: dateOnly(first(text, /^Last Update:[ \t]*(\S+)/m)),
      expiresAt: dateOnly(first(text, /^Expire Date:[ \t]*(\S+)/m)),
      statuses: fields([status]),
      nameservers: hosts(block(text, /^Nameservers[ \t]*$/m)),
      dnssec: signed === 'yes' ? true : signed === 'no' ? false : null,
    });
  },
};

/** nic.at (.at). Free: "% nothing found"; registered records end their domain block with "source: AT-DOM". */
const nicAt: WhoisParser = {
  id: 'nic-at',
  version: 'whois-nic-at/1',
  classify(text, ctx) {
    const found = names(text, /^domain:(.*)$/gm);
    const missing = /^% nothing found[ \t]*$/m.test(text);
    if (missing && (found.length > 0 || /^(?:registrar|registrant|nserver|changed|source):/m.test(text))) return conflicting(ctx, 'not-found text and record lines');
    if (missing) return noRecord(ctx, null, 'answered "% nothing found"');
    const identity = soleName(ctx, found);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    if (!/^source:[ \t]*AT-DOM[ \t]*$/m.test(text)) return INCOMPLETE(ctx.spec.host, 'a "source: AT-DOM" line');
    return registered(ctx, name, {
      ...NO_DETAILS,
      registrar: sanitizeField(first(text, /^registrar:[ \t]*(\S.*?)(?:[ \t]*\([ \t]*https?:\S+[ \t]*\))?[ \t]*$/m)),
      updatedAt: dateOnly(first(text, /^changed:[ \t]*(\d{8})/m)),
      nameservers: hosts(all(text, /^nserver:[ \t]*(\S+)/gm)),
    });
  },
};

/**
 * HKIRC (.hk and com.hk, org.hk, ...). Free: the whole reply is "The domain has not been registered."
 * Throttle: "Please maintain at least 10-second time before starting another enquiry." (reference
 * capture); Domain Scout also spaces queries by that interval.
 */
const hkirc: WhoisParser = {
  id: 'hkirc',
  version: 'whois-hkirc/1',
  classify(text, ctx) {
    const pause = /^Please maintain at least (\d+)-second time before starting another enquiry\./m.exec(text);
    if (pause) return rateLimited(ctx, `HKIRC asks for at least ${pause[1]} s between queries`, Math.max(Number(pause[1]), ctx.spec.rateLimitCooldownSeconds));
    if (text.trim() === 'The domain has not been registered.') return noRecord(ctx, null, 'answered "The domain has not been registered."');
    const identity = soleName(ctx, names(text, /^Domain Name:(.*)$/gm));
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const stated_ = soleValue(ctx, text, /^Domain Status:(.*)$/gm, 'Domain Status lines');
    if ('result' in stated_) return stated_.result;
    const status = stated_.value;
    if (!status || !/^Domain Name Commencement Date:[ \t]*\S/m.test(text)) return INCOMPLETE(ctx.spec.host, 'Domain Status and Domain Name Commencement Date lines');
    const nsBlock = /^Name Servers Information:[ \t]*\n(?:[ \t]*\n)*((?:[A-Za-z0-9.-]+[ \t]*\n?)+)/m.exec(text)?.[1] ?? '';
    const dnssec = first(text, /^DNSSEC:[ \t]*(\S+)/m)?.toLowerCase();
    return registered(ctx, name, {
      registrar: sanitizeField(first(text, /^Registrar Name:[ \t]*(\S.*?)[ \t]*$/m)),
      createdAt: dateOnly(first(text, /^Domain Name Commencement Date:[ \t]*(\S+)/m)),
      updatedAt: null,
      expiresAt: dateOnly(first(text, /^Expiry Date:[ \t]*(\S+)/m)),
      statuses: fields([status]),
      nameservers: hosts(nsBlock.split('\n').map((line) => line.trim())),
      dnssec: dnssec === undefined ? null : dnssec !== 'unsigned',
    });
  },
};

/**
 * TCI for the Coordination Center (.ru). Field meanings and the 120 queries per minute limit from
 * the official service description (https://tcinet.ru/documents/whois_ru_rf.pdf, v1.0, 2022-09-12).
 * Free: "No entries found for the selected source(s)." under the "% TCI Whois Service" banner.
 */
const tci: WhoisParser = {
  id: 'tci',
  version: 'whois-tci/1',
  classify(text, ctx) {
    if (!/^% TCI Whois Service/m.test(text)) return UNRECOGNIZED(ctx.spec.host);
    const found = names(text, /^domain:(.*)$/gm);
    const missing = /^No entries found for the selected source\(s\)\.[ \t]*$/m.test(text);
    if (missing && (found.length > 0 || /^(?:state|created|paid-till|free-date|nserver|registrar):/m.test(text))) return conflicting(ctx, 'not-found text and record lines');
    if (missing) return noRecord(ctx, null, 'answered "No entries found for the selected source(s)."');
    const identity = soleName(ctx, found);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const stateLine = soleValue(ctx, text, /^state:(.*)$/gm, 'state lines');
    if ('result' in stateLine) return stateLine.result;
    const state = stateLine.value;
    if (!state || !/^created:[ \t]*\S/m.test(text)) return INCOMPLETE(ctx.spec.host, 'state and created lines');
    return registered(ctx, name, {
      registrar: sanitizeField(first(text, /^registrar:[ \t]*(\S.*)$/m)),
      createdAt: toIso(first(text, /^created:[ \t]*(\S+)/m)),
      updatedAt: null,
      expiresAt: toIso(first(text, /^paid-till:[ \t]*(\S+)/m)),
      statuses: fields(state.split(',').map((part) => part.trim())),
      nameservers: hosts(all(text, /^nserver:[ \t]*(\S+)/gm)),
      dnssec: null,
    });
  },
};

/** TRABIS (.tr and com.tr, org.tr, ...). Free: "No match found for <name>"; records start "** Domain Name:". */
const trabis: WhoisParser = {
  id: 'trabis',
  version: 'whois-trabis/1',
  classify(text, ctx) {
    // The current reply is unquoted; the pre-2022 one quoted the name. A half-quoted line matches neither.
    const missing = [
      ...new Set(
        [...text.matchAll(/^No match found for (.*)$/gm)].map((match) => {
          const echoed = match[1]!.trim();
          const bare = /^"([^"\s]+)"$/.exec(echoed)?.[1] ?? (/^[^"\s]+$/.test(echoed) ? echoed : undefined);
          return asciiName(bare) ?? '';
        }),
      ),
    ];
    const found = names(text, /^\*\* Domain Name:(.*)$/gm);
    if (missing.length > 0 && (found.length > 0 || /^(?:Domain Status:|Created on|Expires on|\*\* Domain Servers:)/m.test(text))) return conflicting(ctx, 'not-found text and record lines');
    if (missing.length > 0) return echoedNegative(ctx, missing, 'answered "No match found"');
    const identity = soleName(ctx, found);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const stated_ = soleValue(ctx, text, /^Domain Status:(.*)$/gm, 'Domain Status lines');
    if ('result' in stated_) return stated_.result;
    const status = stated_.value;
    const created = /^Created on\.*:[ \t]*(\d{4})-(\w{3})-(\d{2})/m.exec(text);
    if (!status || !created) return INCOMPLETE(ctx.spec.host, 'Domain Status and Created on lines');
    const expires = /^Expires on\.*:[ \t]*(\d{4})-(\w{3})-(\d{2})/m.exec(text);
    const nsBlock = /^\*\* Domain Servers:[ \t]*\n((?:(?!\*\*)[^\n]*\n?)*)/m.exec(text)?.[1] ?? '';
    return registered(ctx, name, {
      ...NO_DETAILS,
      registrar: sanitizeField(first(text, /^Organization Name[ \t]*:[ \t]*(\S.*)$/m)),
      createdAt: dayMonthYear(created[3]!, created[2]!, created[1]!),
      expiresAt: expires ? dayMonthYear(expires[3]!, expires[2]!, expires[1]!) : null,
      statuses: fields([status]),
      nameservers: hosts(nsBlock.split('\n').map((line) => line.trim().split(/[ \t]+/)[0] ?? '')),
    });
  },
};

/** ISOC-IL (co.il, org.il, ...). Free: "% No data was found to match the request criteria." */
const isocIl: WhoisParser = {
  id: 'isoc-il',
  version: 'whois-isoc-il/1',
  classify(text, ctx) {
    const found = names(text, /^domain:(.*)$/gm);
    const queried = names(text, /^query:(.*)$/gm);
    const missing = /^% No data was found to match the request criteria\.[ \t]*$/m.test(text);
    if (missing && (found.length > 0 || /^(?:status|validity|assigned|nserver|registrar name):/m.test(text))) return conflicting(ctx, 'not-found text and record lines');
    if (missing && queried.length === 0) return noRecord(ctx, null, 'answered "No data was found to match the request criteria."');
    if (missing) return echoedNegative(ctx, queried, 'answered "No data was found to match the request criteria."');
    const identity = soleName(ctx, [...new Set([...found, ...queried])]);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const stated_ = soleValue(ctx, text, /^status:(.*)$/gm, 'status lines');
    if ('result' in stated_) return stated_.result;
    const status = stated_.value;
    if (!status || !/^validity:[ \t]*\S/m.test(text)) return INCOMPLETE(ctx.spec.host, 'status and validity lines');
    const dnssec = first(text, /^DNSSEC:[ \t]*(\S+)/m)?.toLowerCase();
    return registered(ctx, name, {
      registrar: sanitizeField(first(text, /^registrar name:[ \t]*(\S.*)$/m)),
      createdAt: dateOnly(first(text, /^assigned:[ \t]*(\S+)/m)),
      updatedAt: null,
      expiresAt: dateOnly(first(text, /^validity:[ \t]*(\S+)/m)),
      statuses: fields([status, ...all(text, /^remarks:[ \t]*(Domain not renewed\..*)$/gm)]),
      nameservers: hosts(all(text, /^nserver:[ \t]*(\S+)/gm)),
      dnssec: dnssec === undefined ? null : dnssec !== 'unsigned',
    });
  },
};

/** .aeDA (.ae and co.ae, net.ae, ...). Free: the whole reply is "No Data Found"; records have no dates. */
const aeda: WhoisParser = {
  id: 'aeda',
  version: 'whois-aeda/1',
  classify(text, ctx) {
    if (text.trim() === 'No Data Found') return noRecord(ctx, null, 'answered "No Data Found"');
    const identity = soleName(ctx, names(text, /^Domain Name:(.*)$/gm));
    if ('result' in identity) return identity.result;
    const name = identity.name;
    const stated_ = soleValue(ctx, text, /^Status:(.*)$/gm, 'Status lines');
    if ('result' in stated_) return stated_.result;
    const status = stated_.value;
    if (!status || !/^Registrar ID:[ \t]*\S/m.test(text)) return INCOMPLETE(ctx.spec.host, 'Status and Registrar ID lines');
    return registered(ctx, name, {
      ...NO_DETAILS,
      registrar: sanitizeField(first(text, /^Registrar Name:[ \t]*(\S.*?)[ \t]*$/m)),
      statuses: fields([status]),
      nameservers: hosts(all(text, /^Name Server:[ \t]*(\S+)/gm)),
    });
  },
};

/** SaudiNIC (.sa and com.sa, ...). Free: "No Match for domain: <name>" (older replies omit "domain: "). */
const saudiNic: WhoisParser = {
  id: 'saudinic',
  version: 'whois-saudinic/1',
  classify(text, ctx) {
    const missing = names(text, /^No Match for (?:domain: )?(.*)$/gm);
    const found = names(text, /^Domain Name:(.*)$/gm);
    if (missing.length > 0 && (found.length > 0 || /^(?:Registrant Name|Name Server|DNSSEC|Created on|Last Updated on):/m.test(text))) {
      return conflicting(ctx, 'not-found text and record lines');
    }
    if (missing.length > 0) return echoedNegative(ctx, missing, 'answered "No Match"');
    const identity = soleName(ctx, found);
    if ('result' in identity) return identity.result;
    const name = identity.name;
    if (!/^(?:Registrant Name|Name Server):[ \t]*\S/m.test(text)) return INCOMPLETE(ctx.spec.host, 'Registrant Name or Name Server lines');
    const dnssec = first(text, /^DNSSEC:[ \t]*(\S+)/m)?.toLowerCase();
    return registered(ctx, name, {
      ...NO_DETAILS,
      nameservers: hosts(all(text, /^Name Server:[ \t]*(\S+)/gm)),
      dnssec: dnssec === undefined ? null : dnssec !== 'unsigned',
    });
  },
};

/**
 * .so registry WHOIS. Free: a "Domain Name:" line echoing the query followed by "The queried object
 * does not exist: No Object Found"; registered records use the ICANN layout.
 */
const nicSo: WhoisParser = {
  id: 'nic-so',
  version: 'whois-nic-so/1',
  classify(text, ctx) {
    if (/^The queried object does not exist: No Object Found[ \t]*$/m.test(text)) {
      // The not-found reply repeats the query on a "Domain Name:" line, but carries no record lines.
      if (/^(?:Registry Domain ID|Creation Date|Updated Date|Registry Expiry Date|Registrar Registration Expiration Date|Registrar|Domain Status|Name Server|DNSSEC):/im.test(text)) {
        return conflicting(ctx, 'not-found text and record lines');
      }
      const echoedNames = names(text, /^Domain Name:(.*)$/gm);
      if (echoedNames.length === 0) return noRecord(ctx, null, 'answered "No Object Found"');
      return echoedNegative(ctx, echoedNames, 'answered "No Object Found"');
    }
    return icannRecord(text, ctx, REGISTRY_DOMAIN_ID);
  },
};

export const CCTLD_WHOIS_PARSERS: WhoisParser[] = [
  identityDigital,
  centralNic,
  websiteWs,
  weAreIe,
  internetNz,
  usRegistry,
  carnet,
  zarc,
  dnsBelgium,
  internetstiftelsen,
  punktum,
  dnsPt,
  nicMexico,
  channelIsles,
  amnic,
  nicIm,
  dnsLu,
  eis,
  nicLv,
  domregDas,
  skNic,
  rnids,
  registerBg,
  nicHu,
  registroIt,
  nicAt,
  hkirc,
  tci,
  trabis,
  isocIl,
  aeda,
  saudiNic,
  nicSo,
];
