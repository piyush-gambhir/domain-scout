import type { Eligibility, NormalizedDomain, RegistrationDetails } from '@domain-scout/contracts';
import { domainToASCII } from 'node:url';
import { NO_RECORD_NOTE, UNKNOWN_ELIGIBILITY, unresolved, type Classification } from '../classification.js';
import { parseRetryAfter, plusSeconds } from '../retry-after.js';
import { normalizeHostName, sanitizeField, toIso } from '../sanitize.js';

export const RDAP_PARSER_VERSION = 'rdap/1';

/** Cooldowns applied when the source gives no Retry-After. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 60;
export const DEFAULT_BLOCK_COOLDOWN_SECONDS = 300;

/** One RDAP HTTP exchange after redirect handling. */
export interface RdapExchange {
  /** Host of the routed registry endpoint, for messages. */
  registryHost: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

/**
 * IANA Registrar ID 376 is "RESERVED-Internet Assigned Numbers Authority" with status Reserved in
 * https://www.iana.org/assignments/registrar-ids (checked 2026-10-05). A registry record sponsored
 * by it is a source-stated reservation, e.g. example.com.
 */
const IANA_RESERVED_REGISTRAR_ID = '376';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isHtml(headers: Record<string, string>, body: string) {
  return (headers['content-type'] ?? '').toLowerCase().includes('html') || /^\s*</.test(body);
}

/** Interprets one RDAP response for `domain` (RFC 9082/9083 semantics, RFC 7480 status codes). */
export function classifyRdap(domain: NormalizedDomain, exchange: RdapExchange, now: Date): Classification {
  const { status, headers, body } = exchange;
  const httpStatus = status;
  const from = exchange.registryHost;

  if (status === 200) return classifyRecord(domain, exchange);

  if (status === 404) {
    if (exchange.truncated) {
      return unresolved('inconclusive', 'truncated_response', `${from} sent a 404 body larger than the size limit`, { httpStatus });
    }
    if (body.trim() === '') {
      return noRecord(httpStatus, `${from} answered 404 with an empty body for ${domain.ascii}: no registration record.`);
    }
    if (isHtml(headers, body)) {
      return unresolved('inconclusive', 'unexpected_404_body', `${from} answered 404 with an HTML page, which is not an RDAP answer`, { httpStatus });
    }
    const parsed = parseJson(body);
    if (isObject(parsed)) {
      // RFC 9083 error shape: errorCode 404, or at least an RDAP conformance marker without a contradicting code.
      const code = parsed.errorCode;
      const codeIs404 = (typeof code === 'number' || typeof code === 'string') && Number(code) === 404;
      const rdapShaped = Array.isArray(parsed.rdapConformance) && code === undefined;
      if (codeIs404 || rdapShaped) return noRecord(httpStatus, `${from} answered 404 for ${domain.ascii}: no registration record.`);
      return unresolved('inconclusive', 'unexpected_404_body', `${from} answered 404 with JSON that is not an RDAP not-found error`, { httpStatus });
    }
    return unresolved('inconclusive', 'unexpected_404_body', `${from} answered 404 with a body that is neither empty nor RDAP JSON`, { httpStatus });
  }

  if (status === 429) {
    const cooldownUntil = parseRetryAfter(headers['retry-after'], now) ?? plusSeconds(now, DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS);
    const told = headers['retry-after'] ? `Retry-After ${headers['retry-after']}` : `no Retry-After; waiting ${DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS} s`;
    return unresolved('rate_limited', 'rate_limited', `${from} rate limited the query (HTTP 429, ${told})`, {
      httpStatus,
      retryable: true,
      cooldownUntil,
      retryAt: cooldownUntil,
    });
  }

  if (status === 403 || status === 451) {
    const retryAfter = parseRetryAfter(headers['retry-after'], now);
    const cooldownUntil = retryAfter ?? (status === 403 ? plusSeconds(now, DEFAULT_BLOCK_COOLDOWN_SECONDS) : null);
    return unresolved('blocked', 'blocked', `${from} refused the query (HTTP ${status})`, {
      httpStatus,
      cooldownUntil,
      retryAt: cooldownUntil,
    });
  }

  if (status >= 500) {
    const cooldownUntil = parseRetryAfter(headers['retry-after'], now);
    return unresolved('inconclusive', 'server_error', `${from} failed with HTTP ${status}`, {
      httpStatus,
      retryable: true,
      cooldownUntil,
      retryAt: cooldownUntil,
    });
  }

  if (status === 400 || status === 422) {
    return unresolved('inconclusive', 'registry_rejected_query', `${from} rejected the query with HTTP ${status}`, { httpStatus });
  }

  return unresolved('inconclusive', 'unexpected_status', `${from} answered with unexpected HTTP ${status}`, { httpStatus });
}

function noRecord(httpStatus: number, message: string): Classification {
  return {
    outcome: 'no_record',
    reason: { code: 'registry_not_found', message: `${message} ${NO_RECORD_NOTE}` },
    httpStatus,
    matchedName: null,
    registration: null,
    eligibility: UNKNOWN_ELIGIBILITY,
    retryable: false,
    cooldownUntil: null,
    retryAt: null,
  };
}

function classifyRecord(domain: NormalizedDomain, exchange: RdapExchange): Classification {
  const httpStatus = exchange.status;
  const from = exchange.registryHost;
  if (exchange.truncated) {
    return unresolved('inconclusive', 'truncated_response', `${from} sent a record larger than the size limit`, { httpStatus });
  }
  if (isHtml(exchange.headers, exchange.body)) {
    return unresolved('inconclusive', 'unexpected_content_type', `${from} answered 200 with HTML instead of RDAP JSON`, { httpStatus });
  }
  const parsed = parseJson(exchange.body);
  if (!isObject(parsed)) {
    return unresolved('inconclusive', 'malformed_response', `${from} answered 200 with a body that is not valid JSON`, { httpStatus });
  }
  if (parsed.objectClassName !== 'domain') {
    const detail = typeof parsed.errorCode === 'number' ? ` (errorCode ${parsed.errorCode})` : '';
    return unresolved('inconclusive', 'malformed_response', `${from} answered 200 without an RDAP domain object${detail}`, { httpStatus });
  }

  const matchedName = returnedName(parsed);
  if (matchedName === null) {
    return unresolved('inconclusive', 'missing_identity', `${from} returned a domain object without ldhName or unicodeName`, { httpStatus });
  }
  if (matchedName !== domain.ascii) {
    return unresolved('inconclusive', 'identity_mismatch', `${from} returned a record for ${matchedName}, not ${domain.ascii}`, {
      httpStatus,
      matchedName,
    });
  }

  const registration = details(parsed);
  return {
    outcome: 'registered',
    reason: { code: 'registry_record', message: `${from} returned a registration record for ${domain.ascii}` },
    httpStatus,
    matchedName,
    registration,
    eligibility: eligibility(parsed, registration, from),
    retryable: false,
    cooldownUntil: null,
    retryAt: null,
  };
}

/** ldhName, else unicodeName converted to an A-label; lower case without a trailing dot. */
function returnedName(record: Json): string | null {
  const ldh = normalizeHostName(record.ldhName);
  if (ldh) return ldh;
  const unicode = normalizeHostName(record.unicodeName);
  if (!unicode) return null;
  return domainToASCII(unicode) || null;
}

function vcardFn(entity: Json): string | null {
  const vcard = asArray(entity.vcardArray);
  for (const property of asArray(vcard[1])) {
    const parts = asArray(property);
    if (parts[0] === 'fn') {
      const value = sanitizeField(parts[3]);
      if (value) return value;
    }
  }
  return null;
}

function registrarEntity(record: Json): Json | null {
  for (const entity of asArray(record.entities)) {
    if (isObject(entity) && asArray(entity.roles).includes('registrar')) return entity;
  }
  return null;
}

function details(record: Json): RegistrationDetails {
  const registrar = registrarEntity(record);
  const dates: Record<string, string | null> = { registration: null, expiration: null, 'last changed': null };
  for (const event of asArray(record.events)) {
    if (!isObject(event) || typeof event.eventAction !== 'string') continue;
    const action = event.eventAction.toLowerCase();
    if (action in dates && dates[action] === null) dates[action] = toIso(event.eventDate);
  }
  const statuses = asArray(record.status)
    .map((status) => sanitizeField(status, 80))
    .filter((status): status is string => status !== null)
    .slice(0, 30);
  const nameservers = asArray(record.nameservers)
    .map((ns) => (isObject(ns) ? normalizeHostName(ns.ldhName) : null))
    .filter((ns): ns is string => ns !== null)
    .slice(0, 20);
  const secure = isObject(record.secureDNS) ? record.secureDNS : null;
  return {
    registrar: registrar ? (vcardFn(registrar) ?? sanitizeField(registrar.handle)) : null,
    createdAt: dates.registration ?? null,
    updatedAt: dates['last changed'] ?? null,
    expiresAt: dates.expiration ?? null,
    statuses,
    nameservers,
    dnssec: secure && typeof secure.delegationSigned === 'boolean' ? secure.delegationSigned : null,
  };
}

/** Reserved only when the record says so; a registered record alone says nothing about eligibility. */
function eligibility(record: Json, registration: RegistrationDetails, from: string): Eligibility {
  if (registration.statuses.some((status) => status.toLowerCase() === 'reserved')) {
    return { status: 'reserved', source: `RDAP status "reserved" from ${from}`, scope: 'Registry reservation reported for this name' };
  }
  const registrar = registrarEntity(record);
  const ianaId = asArray(registrar?.publicIds).find(
    (id) => isObject(id) && id.type === 'IANA Registrar ID' && String(id.identifier) === IANA_RESERVED_REGISTRAR_ID,
  );
  if (ianaId) {
    return {
      status: 'reserved',
      source: `${from} RDAP: sponsoring registrar is IANA Registrar ID ${IANA_RESERVED_REGISTRAR_ID} (status Reserved in https://www.iana.org/assignments/registrar-ids)`,
      scope: 'Name held by IANA; not available for ordinary registration',
    };
  }
  return UNKNOWN_ELIGIBILITY;
}
