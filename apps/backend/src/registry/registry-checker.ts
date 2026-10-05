import { Injectable } from '@nestjs/common';
import type { NormalizedDomain } from '@domain-scout/contracts';
import { unresolved, type Classification } from './classification.js';
import { RDAP_PARSER_VERSION, classifyRdap } from './rdap/rdap-classifier.js';
import { RegistryHttpTransport, type HttpGetResponse } from './rdap/http-transport.js';
import { RoutesService, type RegistryRoute } from './routes.service.js';
import { sanitizeText } from './sanitize.js';
import { WHOIS_PARSERS, classifyWhois } from './whois/whois-classifiers.js';
import { WhoisTransport, WhoisTransportError } from './whois/whois-transport.js';

export const RDAP_MAX_BYTES = 1024 * 1024;
export const WHOIS_MAX_BYTES = 128 * 1024;
export const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface CheckOptions {
  /** Cancellation from the job (cancel, service stop). */
  signal: AbortSignal;
  timeoutMs: number;
  now: () => Date;
}

export interface CheckResult {
  classification: Classification;
  parserVersion: string;
  /** Sanitized response for optional raw diagnostics; null when nothing was received. */
  raw: { contentType: string | null; body: string; truncated: boolean } | null;
  /** True when `options.signal` aborted the query; the result is not evidence. */
  aborted: boolean;
}

/** Sends one domain to its routed registry and classifies the answer. Never contacts anything else. */
@Injectable()
export class RegistryChecker {
  constructor(
    private readonly http: RegistryHttpTransport,
    private readonly whois: WhoisTransport,
    private readonly routes: RoutesService,
  ) {}

  async check(domain: NormalizedDomain, route: RegistryRoute, options: CheckOptions): Promise<CheckResult> {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = AbortSignal.any([options.signal, timeout]);
    try {
      return route.protocol === 'rdap'
        ? await this.checkRdap(domain, route, signal, options)
        : await this.checkWhois(domain, route, signal, options);
    } catch (error) {
      const parserVersion = route.protocol === 'rdap' ? RDAP_PARSER_VERSION : this.parser(route).version;
      if (options.signal.aborted) {
        return { classification: unresolved('inconclusive', 'aborted', 'The check was cancelled'), parserVersion, raw: null, aborted: true };
      }
      if (timeout.aborted) {
        return {
          classification: unresolved('inconclusive', 'timeout', `${route.host} did not answer within ${options.timeoutMs} ms`, { retryable: true }),
          parserVersion,
          raw: null,
          aborted: false,
        };
      }
      const detail = error instanceof WhoisTransportError ? error.message : networkDetail(error);
      return {
        classification: unresolved('inconclusive', 'network_error', `Could not reach ${route.host}: ${detail}`, { retryable: true }),
        parserVersion,
        raw: null,
        aborted: false,
      };
    }
  }

  private parser(route: RegistryRoute) {
    const parser = route.whois ? WHOIS_PARSERS[route.whois.parser] : undefined;
    if (!parser) throw new Error(`No WHOIS classifier "${route.whois?.parser}" for .${route.tld}`);
    return parser;
  }

  private async checkRdap(domain: NormalizedDomain, route: RegistryRoute, signal: AbortSignal, options: CheckOptions): Promise<CheckResult> {
    let url = `${route.endpoint}domain/${domain.ascii}`;
    const followed: string[] = [];
    let response: HttpGetResponse;
    for (;;) {
      response = await this.http.get({ url, headers: { accept: 'application/rdap+json' }, signal, maxBytes: RDAP_MAX_BYTES });
      if (!REDIRECT_STATUSES.has(response.status)) break;

      const location = response.headers['location'];
      if (!location) {
        return this.rdapResult(unresolved('inconclusive', 'unexpected_status', `${route.host} redirected without a Location`, { httpStatus: response.status }), response);
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return this.rdapResult(unresolved('inconclusive', 'redirect_refused', `${route.host} redirected to an invalid location`, { httpStatus: response.status }), response);
      }
      if (!isDomainQuery(next, domain.ascii)) {
        return this.rdapResult(
          unresolved('inconclusive', 'redirect_refused', `${route.host} redirected to a path that is not a domain query for ${domain.ascii}; not followed`, {
            httpStatus: response.status,
          }),
          response,
        );
      }
      if (next.protocol !== 'https:' || !this.routes.isVerifiedRdapHost(next.host)) {
        return this.rdapResult(
          unresolved('inconclusive', 'redirect_refused', `${route.host} redirected to ${next.protocol}//${next.host}, which is not a verified registry RDAP host; not followed`, {
            httpStatus: response.status,
          }),
          response,
        );
      }
      if (followed.length >= MAX_REDIRECTS) {
        return this.rdapResult(unresolved('inconclusive', 'too_many_redirects', `${route.host} redirected more than ${MAX_REDIRECTS} times`, { httpStatus: response.status }), response);
      }
      followed.push(next.href);
      url = next.href;
    }

    const finalHost = new URL(url).host.toLowerCase();
    if (response.status === 404 && this.routes.registryIdForHost(finalHost) !== route.registryId) {
      // A negative answer counts only from the routed registry operator.
      return this.rdapResult(
        unresolved('inconclusive', 'unverified_negative', `404 came from ${finalHost} after a redirect, not from the routed registry ${route.host}`, {
          httpStatus: response.status,
        }),
        response,
      );
    }
    const classification = classifyRdap(
      domain,
      { registryHost: route.host, finalUrl: url, status: response.status, headers: response.headers, body: response.body, truncated: response.truncated },
      options.now(),
    );
    if (followed.length > 0) {
      classification.reason = { ...classification.reason, message: `${classification.reason.message} (after redirect to ${new URL(url).host})` };
    }
    return this.rdapResult(classification, response);
  }

  private rdapResult(classification: Classification, response: HttpGetResponse): CheckResult {
    const sanitized = sanitizeText(response.body);
    return {
      classification,
      parserVersion: RDAP_PARSER_VERSION,
      raw: { contentType: response.headers['content-type'] ?? null, body: sanitized.text, truncated: response.truncated || sanitized.truncated },
      aborted: false,
    };
  }

  private async checkWhois(domain: NormalizedDomain, route: RegistryRoute, signal: AbortSignal, options: CheckOptions): Promise<CheckResult> {
    const spec = route.whois!;
    const parser = this.parser(route);
    const response = await this.whois.query({
      host: spec.host,
      port: spec.port,
      query: spec.query.replace('{domain}', domain.ascii),
      signal,
      maxBytes: WHOIS_MAX_BYTES,
    });
    const classification = classifyWhois(parser, response, { domain, spec, now: options.now() });
    const sanitized = sanitizeText(response.text);
    return {
      classification,
      parserVersion: parser.version,
      raw: { contentType: 'text/plain', body: sanitized.text, truncated: response.truncated || sanitized.truncated },
      aborted: false,
    };
  }
}

/** A redirect target must still be an RDAP domain query for the same name (RFC 9082 path `.../domain/<name>`). */
function isDomainQuery(url: URL, ascii: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    return false;
  }
  return path.endsWith(`/domain/${ascii}`) && url.search === '';
}

function networkDetail(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ?? cause?.message ?? (error as Error)?.message ?? 'network error';
}
