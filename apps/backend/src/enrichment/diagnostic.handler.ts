import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  RESOLVED_ITEM_OUTCOMES,
  Resolver as ResolverSchema,
  type Diagnostic,
  type DiagnosticCheck,
  type DiagnosticOutcome,
  type Resolver,
} from '@domain-scout/contracts';
import type { JobItemRecord, OperationContext, OperationHandler, OperationResult } from '../jobs/operation.js';
import type { ObservationWrite } from '../storage/evidence.js';
import { SettingsService } from '../system/settings.service.js';
import { isPublicAddress, isValidHostname } from './address.js';
import { classifyError, discardBody, readBounded, retryAfter, throwIfJobAborted, withTimeout } from './net.js';
import {
  DNS_TRANSPORT,
  ENRICHMENT_FETCH,
  HTTP_PROBE,
  TLS_PROBE,
  USER_AGENT,
  type DnsRecord,
  type DnsRecordType,
  type DnsTransport,
  type FetchLike,
  type HttpProbe,
  type HttpProbeResponse,
  type TlsProbe,
  type TlsProbeResult,
} from './transports.js';

const DOH_MAX_BYTES = 64 * 1024;
const HTTP_MAX_BYTES = 64 * 1024;
const RAW_MAX_BYTES = 16 * 1024;
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

export const DOH_ENDPOINTS: Record<Exclude<Resolver, 'system'>, { host: string; url: string }> = {
  cloudflare: { host: 'cloudflare-dns.com', url: 'https://cloudflare-dns.com/dns-query' },
  google: { host: 'dns.google', url: 'https://dns.google/resolve' },
};

const TYPE_CODES = { A: 1, NS: 2, CNAME: 5, MX: 15, AAAA: 28, DS: 43, DNSKEY: 48 } as const;
type QueryType = DnsRecordType | 'DS' | 'DNSKEY';

/** DNS over HTTPS JSON response (Cloudflare and Google share this format). */
export interface DohResponse {
  Status: number;
  AD?: boolean;
  Answer?: { name: string; type: number; TTL?: number; data: string }[];
}

type QueryStatus = 'ok' | 'nodata' | 'nxdomain' | 'error' | 'timeout';

interface QueryResult {
  status: QueryStatus;
  records: DnsRecord[];
  raw: string[];
  ad: boolean | null;
  error?: string;
  /** Stable reason code for errors, e.g. dns_error, rate_limited, unexpected_redirect. */
  errorCode?: string;
  retryable?: boolean;
  /** The resolver rate limited this query; no further queries go to it in this check. */
  rateLimited?: boolean;
  cooldownUntil?: string | null;
  rawBody?: string;
}

interface Observed {
  outcome: DiagnosticOutcome;
  destination: string;
  reason: { code: string; message: string };
  data: Record<string, unknown>;
  retryable?: boolean;
  cooldownUntil?: string | null;
  raw?: ObservationWrite['raw'];
}

/**
 * `diagnostic` items: subject is the ASCII domain, target is the check (dns, nameservers, dnssec,
 * tls, http). Diagnostics are independent evidence and never write or change registry outcomes.
 */
@Injectable()
export class DiagnosticHandler implements OperationHandler {
  readonly operation = 'diagnostic' as const;

  constructor(
    @Inject(ENRICHMENT_FETCH) private readonly fetch: FetchLike,
    @Inject(DNS_TRANSPORT) private readonly dns: DnsTransport,
    @Inject(TLS_PROBE) private readonly tls: TlsProbe,
    @Inject(HTTP_PROBE) private readonly http: HttpProbe,
    private readonly settings: SettingsService,
  ) {}

  sourceKey(item: JobItemRecord): string | null {
    const check = item.target as DiagnosticCheck;
    if (check === 'tls' || check === 'http') return `host:${item.subject}`;
    const resolver = this.resolverFor(item);
    if (check === 'dnssec' && resolver === 'system') return null;
    return `resolver:${resolver}`;
  }

  destination(item: JobItemRecord): string | null {
    const check = item.target as DiagnosticCheck;
    if (check === 'tls') return `${item.subject}:443`;
    if (check === 'http') return `https://${item.subject}/`;
    const resolver = this.resolverFor(item);
    if (resolver === 'system') return check === 'dnssec' ? null : 'system resolver';
    return DOH_ENDPOINTS[resolver].host;
  }

  async execute(item: JobItemRecord, ctx: OperationContext): Promise<OperationResult> {
    const checkedAt = ctx.now();
    const check = item.target as DiagnosticCheck;
    const resolver = this.resolverFor(item, ctx.settings.diagnostics.resolver);
    const keepRaw = ctx.settings.privacy.keepRawDiagnostics;
    let observed: Observed;
    switch (check) {
      case 'dns':
        observed = await this.dnsCheck(item.subject, ['A', 'AAAA', 'MX'], resolver, ctx, keepRaw);
        break;
      case 'nameservers':
        observed = await this.dnsCheck(item.subject, ['NS'], resolver, ctx, keepRaw);
        break;
      case 'dnssec':
        observed = await this.dnssecCheck(item.subject, resolver, ctx, keepRaw);
        break;
      case 'tls':
        observed = await this.tlsCheck(item.subject, ctx);
        break;
      case 'http':
        observed = await this.httpCheck(item.subject, ctx, keepRaw);
        break;
      default:
        observed = {
          outcome: 'error',
          destination: 'none',
          reason: { code: 'unknown_check', message: `Unknown diagnostic check ${String(item.target)}` },
          data: {},
        };
    }
    return this.result(item, check, ctx, checkedAt, observed);
  }

  private resolverFor(item: JobItemRecord, fallback?: Resolver): Resolver {
    const parsed = ResolverSchema.safeParse(item.jobInput?.resolver);
    if (parsed.success) return parsed.data;
    return fallback ?? this.settings.get().diagnostics.resolver;
  }

  private resolverDestination(resolver: Resolver): string {
    if (resolver === 'system') {
      const servers = safeServers(this.dns);
      return servers.length ? `system resolver (${servers.join(', ')})` : 'system resolver';
    }
    return DOH_ENDPOINTS[resolver].host;
  }

  /* DNS records (A/AAAA/MX) and nameservers (NS). */

  private async dnsCheck(
    domain: string,
    types: DnsRecordType[],
    resolver: Resolver,
    ctx: OperationContext,
    keepRaw: boolean,
  ): Promise<Observed> {
    const destination = this.resolverDestination(resolver);
    const results: Partial<Record<DnsRecordType, QueryResult>> = {};
    const skipped: DnsRecordType[] = [];
    for (const type of types) {
      if (Object.values(results).some((r) => r.rateLimited)) {
        skipped.push(type);
        continue;
      }
      const result = await this.query(domain, type, resolver, ctx);
      results[type] = result;
      if (result.status === 'nxdomain') break;
    }
    const cooldownUntil = latestTime(Object.values(results).map((r) => r.cooldownUntil));
    const entries = Object.entries(results) as [DnsRecordType, QueryResult][];
    const data: Record<string, unknown> = {
      resolver,
      records: Object.fromEntries(entries.map(([type, r]) => [type, recordValues(type, r.records)])),
      status: Object.fromEntries(entries.map(([type, r]) => [type, r.status])),
      authenticatedData: resolver === 'system' ? null : entries.some(([, r]) => r.ad === true),
    };
    if (results.MX) data.nullMx = results.MX.records.length === 1 && stripDot(results.MX.records[0]!.value) === '';
    if (resolver !== 'system') data.endpoint = DOH_ENDPOINTS[resolver].url;
    else data.servers = safeServers(this.dns);
    const errors = Object.fromEntries(
      entries.filter(([, r]) => r.error).map(([type, r]) => [type, { code: r.errorCode ?? 'dns_error', message: r.error }]),
    );
    if (Object.keys(errors).length) data.errors = errors;
    if (skipped.length) data.skipped = skipped;
    const raw = keepRaw ? rawOf(entries.map(([type, r]) => (r.rawBody ? `; ${type}\n${r.rawBody}` : '')).join('\n')) : null;

    const statuses = entries.map(([, r]) => r.status);
    const what = types.includes('NS') ? 'nameservers' : 'DNS records';
    if (entries.some(([, r]) => r.status === 'ok')) {
      // Partial answers stay observed; failed or skipped types are listed in data.errors and data.skipped.
      const incomplete = [...Object.keys(errors), ...skipped];
      return {
        outcome: 'observed',
        destination,
        reason: incomplete.length
          ? { code: 'partial_answer', message: `Observed ${what} from the ${resolver} resolver; ${incomplete.join(', ')} could not be checked` }
          : { code: 'answer', message: `Observed ${what} from the ${resolver} resolver` },
        data,
        raw,
        cooldownUntil,
      };
    }
    if (statuses.includes('nxdomain')) {
      return {
        outcome: 'no_answer',
        destination,
        reason: {
          code: 'nxdomain',
          message: 'The resolver reported that the name does not exist in DNS (NXDOMAIN). DNS absence is not evidence that the domain is unregistered.',
        },
        data,
        raw,
      };
    }
    if (statuses.every((s) => s === 'nodata')) {
      return {
        outcome: 'no_answer',
        destination,
        reason: { code: 'nodata', message: `The resolver returned no ${what} for this name (NODATA). This says nothing about registration.` },
        data,
        raw,
      };
    }
    const timedOut = statuses.includes('timeout');
    const firstError = entries.find(([, r]) => r.status === 'error' || r.status === 'timeout')?.[1];
    return {
      outcome: timedOut ? 'timeout' : 'error',
      destination,
      reason: timedOut
        ? { code: 'timeout', message: `The ${resolver} resolver did not answer in time` }
        : { code: firstError?.errorCode ?? 'dns_error', message: firstError?.error ?? 'DNS lookup failed' },
      data,
      raw,
      retryable: entries.some(([, r]) => r.retryable),
      cooldownUntil,
    };
  }

  /* DNSSEC: DS at the parent and DNSKEY at the zone, plus the resolver's AD flag. */

  private async dnssecCheck(domain: string, resolver: Resolver, ctx: OperationContext, keepRaw: boolean): Promise<Observed> {
    if (resolver === 'system') {
      return {
        outcome: 'error',
        destination: 'none',
        reason: {
          code: 'unsupported_resolver',
          message: 'The system resolver does not expose DNSSEC validation status; choose the cloudflare or google resolver',
        },
        data: { resolver },
      };
    }
    const destination = DOH_ENDPOINTS[resolver].host;
    const ds = await this.doh(domain, 'DS', resolver, ctx, true);
    const dnskey = ds.status === 'nxdomain' || ds.rateLimited ? null : await this.doh(domain, 'DNSKEY', resolver, ctx, true);
    const data: Record<string, unknown> = {
      resolver,
      endpoint: DOH_ENDPOINTS[resolver].url,
      ds: ds.raw.map(parseDs),
      dnskey: (dnskey?.raw ?? []).map(parseDnskey),
      status: { DS: ds.status, DNSKEY: dnskey?.status ?? null },
      authenticatedData: { DS: ds.ad, DNSKEY: dnskey?.ad ?? null },
    };
    const raw = keepRaw ? rawOf([ds.rawBody, dnskey?.rawBody].filter(Boolean).join('\n')) : null;
    // A cooldown from either query applies, whichever failure is reported.
    const cooldownUntil = latestTime([ds.cooldownUntil, dnskey?.cooldownUntil]);
    if (ds.status === 'nxdomain') {
      return {
        outcome: 'no_answer',
        destination,
        reason: { code: 'nxdomain', message: 'The resolver reported that the name does not exist in DNS (NXDOMAIN)' },
        data,
        raw,
      };
    }
    const failed = [ds, dnskey].find((r) => r && (r.status === 'error' || r.status === 'timeout'));
    if (failed) {
      return {
        outcome: failed.status === 'timeout' ? 'timeout' : 'error',
        destination,
        reason:
          failed.status === 'timeout'
            ? { code: 'timeout', message: 'The resolver did not answer in time' }
            : { code: failed.errorCode ?? 'dns_error', message: failed.error ?? 'DNS lookup failed' },
        data,
        raw,
        retryable: [ds, dnskey].some((r) => r?.retryable),
        cooldownUntil,
      };
    }
    const hasDs = ds.raw.length > 0;
    const hasDnskey = (dnskey?.raw.length ?? 0) > 0;
    const validated = hasDs && hasDnskey && ds.ad === true && dnskey?.ad === true;
    data.signed = hasDs;
    data.validated = validated;
    const reason = validated
      ? { code: 'validated', message: 'DS and DNSKEY records are published and the resolver set the AD (authenticated data) flag' }
      : hasDs
        ? { code: 'signed_not_validated', message: 'A DS record is published but the resolver did not report a validated answer' }
        : { code: 'unsigned', message: 'No DS record is published at the parent zone, so the domain does not appear to use DNSSEC' };
    return { outcome: 'observed', destination, reason, data, raw, cooldownUntil };
  }

  private async query(domain: string, type: DnsRecordType, resolver: Resolver, ctx: OperationContext): Promise<QueryResult> {
    return resolver === 'system' ? this.systemQuery(domain, type, ctx) : this.doh(domain, type, resolver, ctx, false);
  }

  private async systemQuery(domain: string, type: DnsRecordType, ctx: OperationContext): Promise<QueryResult> {
    const timer = withTimeout(ctx.signal, ctx.settings.retries.timeoutMs);
    try {
      const records = await this.dns.query(domain, type, { timeoutMs: ctx.settings.retries.timeoutMs, signal: timer.signal });
      return { status: records.length ? 'ok' : 'nodata', records, raw: [], ad: null };
    } catch (error) {
      throwIfJobAborted(ctx.signal);
      const code = (error as { code?: string })?.code;
      if (code === 'ENOTFOUND') return { status: 'nxdomain', records: [], raw: [], ad: null };
      if (code === 'ENODATA') return { status: 'nodata', records: [], raw: [], ad: null };
      const failure = classifyError(error, timer.timedOut() || code === 'ECANCELLED');
      return {
        status: failure.kind === 'timeout' ? 'timeout' : 'error',
        records: [],
        raw: [],
        ad: null,
        error: `${code ?? failure.code}: ${failure.message}`,
        retryable: failure.kind === 'timeout' || code === 'ESERVFAIL',
      };
    }
  }

  private async doh(
    domain: string,
    type: QueryType,
    resolver: Exclude<Resolver, 'system'>,
    ctx: OperationContext,
    dnssecOk: boolean,
  ): Promise<QueryResult> {
    const endpoint = DOH_ENDPOINTS[resolver];
    const url = `${endpoint.url}?name=${encodeURIComponent(domain)}&type=${type}${dnssecOk ? '&do=1' : ''}`;
    const timer = withTimeout(ctx.signal, ctx.settings.retries.timeoutMs);
    try {
      const response = await this.fetch(url, {
        redirect: 'manual',
        headers: { accept: 'application/dns-json', 'user-agent': USER_AGENT },
        signal: timer.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await discardBody(response);
        const host = safeHost(response.headers.get('location'), url);
        return {
          status: 'error',
          records: [],
          raw: [],
          ad: null,
          errorCode: 'unexpected_redirect',
          error: `DNS over HTTPS resolver redirected to ${host ?? 'an unknown location'}; the redirect was not followed`,
          retryable: false,
        };
      }
      if (response.status === 429) {
        await discardBody(response);
        const cooldownUntil =
          retryAfter(response.headers.get('retry-after'), ctx.now()) ?? new Date(ctx.now().getTime() + DEFAULT_RATE_LIMIT_WAIT_MS).toISOString();
        return {
          status: 'error',
          records: [],
          raw: [],
          ad: null,
          errorCode: 'rate_limited',
          error: `DNS over HTTPS resolver rate limited the request; retry after ${cooldownUntil}`,
          retryable: true,
          rateLimited: true,
          cooldownUntil,
        };
      }
      if (!response.ok) {
        await discardBody(response);
        return {
          status: 'error',
          records: [],
          raw: [],
          ad: null,
          errorCode: 'http_error',
          error: `DNS over HTTPS resolver returned HTTP ${response.status}`,
          retryable: response.status >= 500,
        };
      }
      const body = await readBounded(response, DOH_MAX_BYTES);
      const parsed = parseDoh(body.text);
      if (!parsed) {
        return { status: 'error', records: [], raw: [], ad: null, errorCode: 'malformed_response', error: 'Malformed DNS over HTTPS response', rawBody: body.text };
      }
      return { ...interpretDoh(parsed, type), rawBody: body.text };
    } catch (error) {
      throwIfJobAborted(ctx.signal);
      const failure = classifyError(error, timer.timedOut());
      return {
        status: failure.kind === 'timeout' ? 'timeout' : 'error',
        records: [],
        raw: [],
        ad: null,
        error: `${failure.code}: ${failure.message}`,
        retryable: failure.kind === 'timeout' || failure.kind === 'error',
      };
    }
  }

  /*
   * Connection targets. The domain is validated and resolved first; if any address is non-public
   * (loopback, private, link-local, shared, reserved or multicast) no connection is made, so a
   * requested diagnostic cannot be used to reach local services.
   */

  private async vetTarget(
    domain: string,
    destination: string,
    ctx: OperationContext,
    timer: ReturnType<typeof withTimeout>,
  ): Promise<{ addresses: string[]; failure?: undefined } | { failure: Observed }> {
    if (!isValidHostname(domain)) {
      return {
        failure: {
          outcome: 'error',
          destination,
          reason: { code: 'invalid_domain', message: `${domain} is not a valid host name; no connection was made` },
          data: { host: domain },
        },
      };
    }
    let addresses: string[];
    try {
      addresses = await this.dns.lookup(domain, { signal: timer.signal });
    } catch (error) {
      throwIfJobAborted(ctx.signal);
      const failure = classifyError(error, timer.timedOut());
      return {
        failure: {
          outcome: failure.kind === 'timeout' ? 'timeout' : failure.kind === 'unreachable' ? 'unreachable' : 'error',
          destination,
          reason: { code: failure.code, message: `Address lookup failed: ${failure.message}` },
          data: { host: domain },
          retryable: failure.kind === 'timeout',
        },
      };
    }
    if (addresses.length === 0) {
      return {
        failure: { outcome: 'unreachable', destination, reason: { code: 'no_address', message: `${domain} has no address to connect to` }, data: { host: domain } },
      };
    }
    const nonPublic = addresses.filter((address) => !isPublicAddress(address));
    if (nonPublic.length) {
      return {
        failure: {
          outcome: 'error',
          destination,
          reason: {
            code: 'non_public_address',
            message: `${domain} resolves to a non-public address (${nonPublic.join(', ')}); no connection was made`,
          },
          data: { host: domain, addresses },
        },
      };
    }
    return { addresses };
  }

  /* TLS certificate on port 443 with SNI, pinned to a vetted address. */

  private async tlsCheck(domain: string, ctx: OperationContext): Promise<Observed> {
    const destination = `${domain}:443`;
    const timer = withTimeout(ctx.signal, ctx.settings.retries.timeoutMs);
    const target = await this.vetTarget(domain, destination, ctx, timer);
    if (target.failure) return target.failure;
    // One IPv4 and one IPv6 candidate: the second is tried only when the first is unreachable.
    const candidates = [target.addresses.find((a) => isIP(a) === 4), target.addresses.find((a) => isIP(a) === 6)].filter(
      (a): a is string => Boolean(a),
    );
    let lastFailure: ReturnType<typeof classifyError> | null = null;
    for (const address of candidates) {
      try {
        const probe = await this.tls(address, 443, { timeoutMs: ctx.settings.retries.timeoutMs, signal: timer.signal, servername: domain });
        return this.tlsObserved(domain, destination, address, target.addresses, probe);
      } catch (error) {
        throwIfJobAborted(ctx.signal);
        lastFailure = classifyError(error, timer.timedOut());
        if (lastFailure.kind !== 'unreachable') break;
      }
    }
    const failure = lastFailure ?? { kind: 'error' as const, code: 'no_address', message: 'No address to connect to' };
    return {
      outcome: failure.kind === 'timeout' ? 'timeout' : failure.kind === 'unreachable' ? 'unreachable' : 'error',
      destination,
      reason: { code: failure.code, message: `TLS connection failed: ${failure.message}` },
      data: { host: domain, port: 443, addresses: target.addresses },
      retryable: failure.kind === 'timeout',
    };
  }

  private tlsObserved(domain: string, destination: string, address: string, addresses: string[], probe: TlsProbeResult): Observed {
    const cert = probe.certificate;
    const data: Record<string, unknown> = {
      host: domain,
      port: 443,
      address,
      addresses,
      protocol: probe.protocol,
      authorized: probe.authorized,
      authorizationError: probe.authorizationError,
      subject: cert?.subject ?? null,
      subjectCommonName: commonName(cert?.subject),
      issuer: cert?.issuer ?? null,
      issuerCommonName: commonName(cert?.issuer),
      validFrom: isoDate(cert?.validFrom),
      validTo: isoDate(cert?.validTo),
      subjectAltNames: parseSans(cert?.subjectAltName ?? null),
      fingerprint256: cert?.fingerprint256 ?? null,
      serialNumber: cert?.serialNumber ?? null,
    };
    if (!cert) {
      return { outcome: 'error', destination, reason: { code: 'no_certificate', message: 'The server completed a handshake without a certificate' }, data };
    }
    return {
      outcome: 'observed',
      destination,
      reason: probe.authorized
        ? { code: 'certificate_trusted', message: 'Certificate chain is trusted for this name' }
        : { code: 'certificate_untrusted', message: `Certificate is not trusted: ${probe.authorizationError ?? 'unknown reason'}` },
      data,
    };
  }

  /* Website: HEAD with manual redirects, GET fallback, bounded time and size. */

  private async httpCheck(domain: string, ctx: OperationContext, keepRaw: boolean): Promise<Observed> {
    const url = `https://${domain}/`;
    const destination = url;
    const timer = withTimeout(ctx.signal, ctx.settings.retries.timeoutMs);
    const target = await this.vetTarget(domain, destination, ctx, timer);
    if (target.failure) return target.failure;
    // The request is pinned to the vetted address (no second resolution, so no DNS rebinding);
    // SNI, Host and certificate validation use the domain. Redirects are reported, never followed.
    // One IPv4 and one IPv6 candidate, as for TLS: the next is tried only when one is unreachable.
    const candidates = [target.addresses.find((a) => isIP(a) === 4), target.addresses.find((a) => isIP(a) === 6)].filter(
      (a): a is string => a !== undefined,
    );
    let address = candidates[0] ?? target.addresses[0]!;
    const send = async (method: 'HEAD' | 'GET'): Promise<HttpProbeResponse> => {
      for (;;) {
        try {
          return await this.http({
            method,
            host: domain,
            address,
            path: '/',
            headers: { accept: '*/*', 'user-agent': USER_AGENT },
            timeoutMs: ctx.settings.retries.timeoutMs,
            signal: timer.signal,
            maxBytes: HTTP_MAX_BYTES,
          });
        } catch (error) {
          throwIfJobAborted(ctx.signal);
          const next = candidates[candidates.indexOf(address) + 1];
          if (!next || classifyError(error, timer.timedOut()).kind !== 'unreachable') throw error;
          address = next;
        }
      }
    };
    const started = performance.now();
    let method: 'HEAD' | 'GET' = 'HEAD';
    let headFallback: string | null = null;
    let response: HttpProbeResponse | null = null;
    try {
      response = await send('HEAD');
      if (response.status === 405 || response.status === 501) {
        headFallback = `HEAD returned ${response.status}`;
        response = null;
      }
    } catch (error) {
      throwIfJobAborted(ctx.signal);
      const failure = classifyError(error, timer.timedOut());
      if (failure.kind === 'timeout') return this.httpFailure(destination, failure, url, null);
      headFallback = `HEAD failed: ${failure.code}`;
    }
    if (!response) {
      method = 'GET';
      try {
        response = await send('GET');
      } catch (error) {
        throwIfJobAborted(ctx.signal);
        return this.httpFailure(destination, classifyError(error, timer.timedOut()), url, headFallback);
      }
    }
    const location = response.headers.location ?? null;
    const data: Record<string, unknown> = {
      url,
      method,
      status: response.status,
      statusText: response.statusText || null,
      redirect: response.status >= 300 && response.status < 400,
      location,
      resolvedLocation: location ? safeUrl(location, url) : null,
      server: response.headers.server ?? null,
      contentType: response.headers['content-type'] ?? null,
      elapsedMs: Math.round(performance.now() - started),
      address,
      addresses: target.addresses,
      headFallback,
      bytesRead: method === 'GET' ? response.bytesRead : null,
      truncated: response.truncated,
    };
    const raw = keepRaw
      ? rawOf(
          [
            `HTTP ${response.status} ${response.statusText}`,
            ...Object.entries(response.headers)
              .filter(([k]) => k !== 'set-cookie')
              .map(([k, v]) => `${k}: ${v}`),
          ].join('\n'),
          'text/plain',
        )
      : null;
    return {
      outcome: 'observed',
      destination,
      reason: { code: 'http_response', message: `HTTP ${response.status}${location ? ` redirecting to ${location}` : ''}` },
      data,
      raw,
    };
  }

  private httpFailure(
    destination: string,
    failure: ReturnType<typeof classifyError>,
    url: string,
    headFallback: string | null,
  ): Observed {
    return {
      outcome: failure.kind === 'timeout' ? 'timeout' : failure.kind === 'unreachable' ? 'unreachable' : 'error',
      destination,
      reason: { code: failure.code, message: `Website request failed: ${failure.message}` },
      data: { url, headFallback },
      retryable: failure.kind === 'timeout',
    };
  }

  private result(item: JobItemRecord, check: DiagnosticCheck, ctx: OperationContext, checkedAt: Date, observed: Observed): OperationResult {
    // Freshness is computed at read time; staleAt follows the registry freshness setting.
    const staleAt = new Date(checkedAt.getTime() + ctx.settings.freshness.registryMinutes * 60_000).toISOString();
    const diagnostic: Omit<Diagnostic, 'freshness'> = {
      id: randomUUID(),
      domain: item.subject,
      check,
      outcome: observed.outcome,
      destination: observed.destination,
      checkedAt: checkedAt.toISOString(),
      staleAt,
      reason: observed.reason,
      data: observed.data,
    };
    const resolved = RESOLVED_ITEM_OUTCOMES.diagnostic.includes(observed.outcome);
    return {
      outcome: observed.outcome,
      resolved,
      evidence: [
        {
          kind: 'observation',
          row: {
            id: diagnostic.id,
            kind: 'diagnostic',
            subject: item.subject,
            suffix: item.suffix,
            sourceId: this.sourceKey(item) ?? `resolver:${this.resolverFor(item)}`,
            destination: observed.destination,
            outcome: observed.outcome,
            observedAt: diagnostic.checkedAt,
            staleAt,
            payload: diagnostic as unknown as Record<string, unknown>,
            raw: observed.raw ?? null,
          },
        },
      ],
      error: resolved ? null : { code: observed.reason.code, message: observed.reason.message, retryable: observed.retryable ?? false },
      retryable: observed.retryable ?? false,
      cooldownUntil: observed.cooldownUntil ?? null,
      retryAt: resolved ? null : (observed.cooldownUntil ?? null),
    };
  }
}

/* Parsing helpers, exported for tests. */

export function parseDoh(text: string): DohResponse | null {
  try {
    const value = JSON.parse(text) as DohResponse;
    if (!value || typeof value !== 'object' || typeof value.Status !== 'number') return null;
    if (value.Answer !== undefined && !Array.isArray(value.Answer)) return null;
    return value;
  } catch {
    return null;
  }
}

export function interpretDoh(response: DohResponse, type: QueryType): Omit<QueryResult, 'rawBody'> {
  const ad = response.AD === true;
  if (response.Status === 3) return { status: 'nxdomain', records: [], raw: [], ad };
  if (response.Status !== 0) {
    return { status: 'error', records: [], raw: [], ad, error: `Resolver returned DNS status ${rcodeName(response.Status)}`, retryable: response.Status === 2 };
  }
  const code = TYPE_CODES[type];
  const answers = (response.Answer ?? []).filter((a) => a.type === code && typeof a.data === 'string');
  const raw = answers.map((a) => a.data);
  const records: DnsRecord[] = [];
  if (type !== 'DS' && type !== 'DNSKEY') {
    for (const answer of answers) {
      if (type === 'MX') {
        const [priority, exchange] = answer.data.trim().split(/\s+/);
        records.push({ type, value: stripDot(exchange ?? ''), priority: Number(priority), ttl: answer.TTL });
      } else {
        records.push({ type, value: type === 'NS' ? stripDot(answer.data) : answer.data, ttl: answer.TTL });
      }
    }
  }
  return { status: answers.length ? 'ok' : 'nodata', records, raw, ad };
}

function recordValues(type: DnsRecordType, records: DnsRecord[]) {
  if (type === 'MX') {
    // A null MX (RFC 7505, "0 .") states the domain accepts no mail; keep it visible as ".".
    return records
      .map((r) => ({ priority: r.priority ?? null, exchange: stripDot(r.value) || '.' }))
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.exchange.localeCompare(b.exchange));
  }
  const values = records.map((r) => (type === 'NS' ? stripDot(r.value) : r.value));
  return [...new Set(values)].sort();
}

function parseDs(data: string) {
  const [keyTag, algorithm, digestType, ...digest] = data.trim().split(/\s+/);
  return { keyTag: Number(keyTag), algorithm: Number(algorithm), digestType: Number(digestType), digest: digest.join('').toLowerCase() };
}

function parseDnskey(data: string) {
  const [flags, protocol, algorithm] = data.trim().split(/\s+/);
  const flagValue = Number(flags);
  return { flags: flagValue, protocol: Number(protocol), algorithm: Number(algorithm), secureEntryPoint: (flagValue & 1) === 1 };
}

function rcodeName(status: number) {
  return ({ 1: 'FORMERR', 2: 'SERVFAIL', 4: 'NOTIMP', 5: 'REFUSED' } as Record<number, string>)[status] ?? String(status);
}

function stripDot(value: string) {
  return value.toLowerCase().replace(/\.$/, '');
}

function commonName(name: Record<string, unknown> | null | undefined): string | null {
  const cn = name?.CN;
  return typeof cn === 'string' ? cn : Array.isArray(cn) && typeof cn[0] === 'string' ? cn[0] : null;
}

function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function parseSans(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/,\s*/)
    .map((entry) => (entry.startsWith('DNS:') ? entry.slice(4) : entry))
    .filter(Boolean);
}

/** Latest of several ISO timestamps, or null when none is set. */
function latestTime(values: (string | null | undefined)[]): string | null {
  const times = values.filter((v): v is string => Boolean(v));
  return times.length ? times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}

function safeHost(location: string | null, base: string): string | null {
  if (!location) return null;
  try {
    return new URL(location, base).host;
  } catch {
    return null;
  }
}

function safeUrl(location: string, base: string): string | null {
  try {
    return new URL(location, base).toString();
  } catch {
    return null;
  }
}

function safeServers(dns: DnsTransport): string[] {
  try {
    return dns.servers();
  } catch {
    return [];
  }
}

function rawOf(body: string, contentType = 'application/dns-json'): ObservationWrite['raw'] {
  if (!body) return null;
  const truncated = Buffer.byteLength(body) > RAW_MAX_BYTES;
  return { contentType, body: truncated ? Buffer.from(body).subarray(0, RAW_MAX_BYTES).toString('utf8') : body, truncated };
}
