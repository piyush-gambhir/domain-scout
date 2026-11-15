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










function stated(status: Eligibility['status'], source: string, scope: string): Eligibility {
  return { status, source, scope };
}





function echoedNegative(ctx: WhoisContext, echoes: string[], detail: string): Classification {
  if (echoes.length > 1) return conflicting(ctx, 'names in its not-found reply');
  const name = echoes[0] ?? '';
  if (name !== ctx.domain.ascii) return mismatch(ctx, name || 'an unreadable name');
  return noRecord(ctx, name, detail);
}


function soleName(ctx: WhoisContext, found: string[]): { name: string } | { result: Classification } {
  if (found.length > 1) return { result: conflicting(ctx, 'domain names') };
  const name = found[0];
  if (!name) return { result: UNRECOGNIZED(ctx.spec.host) };
  if (name !== ctx.domain.ascii) return { result: mismatch(ctx, name) };
  return { name };
}


function soleValue(ctx: WhoisContext, text: string, pattern: RegExp, what: string): { value: string | null } | { result: Classification } {
  const found = all(text, pattern);
  if (values(text, pattern).length > 1) return { result: conflicting(ctx, what) };
  return { value: found[0] ?? null };
}

interface IcannStyleOptions {
  id: string;
  version: string;

  notFound(text: string): string[] | null;

  required: { pattern: RegExp; label: string };
}





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


function echoes(text: string, pattern: RegExp): string[] | null {
  const found = names(text, pattern);
  return found.length > 0 ? found : null;
}


const ICANN_RECORD = /^(?:Domain Name|Registry Domain ID|Creation Date|Updated Date|Registry Expiry Date|Registrar Registration Expiration Date|Registrar|Domain Status|Name Server|DNSSEC):/im;

const REGISTRY_DOMAIN_ID = { pattern: /^(?:Registry Domain ID|Registrar):[ \t]*\S/m, label: 'Registry Domain ID or Registrar' };







const identityDigital = icannStyle({
  id: 'identity-digital',
  version: 'whois-identity-digital/1',
  notFound: (text) => (/^Domain not found\.[ \t]*$/m.test(text) ? [] : null),
  required: REGISTRY_DOMAIN_ID,
});


const centralNic = icannStyle({
  id: 'centralnic',
  version: 'whois-centralnic/1',
  notFound: (text) => (/^The queried object does not exist: DOMAIN NOT FOUND[ \t]*$/m.test(text) ? [] : null),
  required: REGISTRY_DOMAIN_ID,
});


const websiteWs = icannStyle({
  id: 'website-ws',
  version: 'whois-website-ws/1',
  notFound: (text) => echoes(text, /^The queried object does not exist:(.*)$/gm),
  required: { pattern: /^Registrar:[ \t]*\S/m, label: 'Registrar' },
});


const furyNotFound = (text: string) => echoes(text, /^Not found:(.*)$/gm);
const weAreIe = icannStyle({ id: 'weare-ie', version: 'whois-weare-ie/1', notFound: furyNotFound, required: REGISTRY_DOMAIN_ID });
const internetNz = icannStyle({
  id: 'internetnz',
  version: 'whois-internetnz/1',
  notFound: furyNotFound,
  required: { pattern: /^Registrar:[ \t]*\S/m, label: 'Registrar' },
});


const usRegistry = icannStyle({
  id: 'us-registry',
  version: 'whois-us-registry/1',
  notFound: (text) => (/^No Data Found[ \t]*$/m.test(text) ? [] : null),
  required: REGISTRY_DOMAIN_ID,
});


const carnet = icannStyle({
  id: 'carnet',
  version: 'whois-carnet/1',
  notFound: (text) => (/^%ERROR: No entries found[ \t]*$/im.test(text) ? [] : null),
  required: { pattern: /^Registrar Registration Expiration Date:[ \t]*\S/m, label: 'Registrar Registration Expiration Date' },
});


const zarc = icannStyle({
  id: 'zarc',
  version: 'whois-zarc/1',
  notFound: (text) => (/^Available[ \t]*\n(?:[ \t]*\n)*No information was found matching that query\.[ \t]*$/m.test(text) ? [] : null),
  required: REGISTRY_DOMAIN_ID,
});







const dnsBelgium: WhoisParser = {
  id: 'dns-belgium',
  version: 'whois-dns-belgium/1',
  classify(text, ctx) {
    if (/^%?[ \t]*-2:[ \t]*Excessive querying/m.test(text)) return rateLimited(ctx, 'DNS Belgium return code -2 (excessive querying)');
    if (/^%?[ \t]*-3:[ \t]*IP address blocked/m.test(text)) return blockedBy(ctx, 'DNS Belgium return code -3 (IP address blocked)', 3600);
    if (/^%?[ \t]*-1:[ \t]*Internal (?:server|system) error/m.test(text)) {
      return unresolved('inconclusive', 'registry_error', `${ctx.spec.host} reported an internal error (return code -1)`, { retryable: true });
    }

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







const punktum: WhoisParser = {
  id: 'punktum',
  version: 'whois-punktum/1',
  classify(text, ctx) {
    const missing = /^No entries found for the selected source\.[ \t]*$/m.test(text);
    if (missing && /^(?:Domain|DNS|Registered|Expires|Registrar|Status|Hostname):/m.test(text)) return conflicting(ctx, 'not-found text and record lines');
    if (missing) return noRecord(ctx, null, 'answered "No entries found for the selected source."');

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





const nicIm: WhoisParser = {
  id: 'nic-im',
  version: 'whois-nic-im/1',
  classify(text, ctx) {
    const missing = echoes(text, /^The domain (.*) was not found\.[ \t]*$/gm);
    const found = names(text, /^Domain Name:(.*)$/gm);
    if (missing) {

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






const dnsLu: WhoisParser = {
  id: 'dns-lu',
  version: 'whois-dns-lu/1',
  classify(text, ctx) {
    if (/^%% Maximum query rate reached/m.test(text)) return rateLimited(ctx, 'DNS-LU maximum query rate reached');

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

const EIS_INACTIVE = new Set(['reserved', 'blocked', 'atauction', 'pendingregistration', 'disputed', 'deletecandidate']);








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


function eisDate(value: string | undefined): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}:\d{2}) ([+-]\d{2}:\d{2}))?/.exec(value?.trim() ?? '');
  if (!match) return null;
  return match[2] ? toIso(`${match[1]}T${match[2]}${match[3]}`) : dateOnly(match[1]);
}


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


const registerBg: WhoisParser = {
  id: 'register-bg',
  version: 'whois-register-bg/1',
  classify(text, ctx) {

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


const trabis: WhoisParser = {
  id: 'trabis',
  version: 'whois-trabis/1',
  classify(text, ctx) {

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





const nicSo: WhoisParser = {
  id: 'nic-so',
  version: 'whois-nic-so/1',
  classify(text, ctx) {
    if (/^The queried object does not exist: No Object Found[ \t]*$/m.test(text)) {

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
