import { Resolver, lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { checkServerIdentity, connect } from 'node:tls';
import { packageVersion } from '../core/config.js';





export const ENRICHMENT_FETCH = Symbol('ENRICHMENT_FETCH');
export const DNS_TRANSPORT = Symbol('DNS_TRANSPORT');
export const TLS_PROBE = Symbol('TLS_PROBE');
export const HTTP_PROBE = Symbol('HTTP_PROBE');

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;


export const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

export const USER_AGENT = `DomainScout/${packageVersion()} (local naming research tool; requested name checks only)`;

export type DnsRecordType = 'A' | 'AAAA' | 'MX' | 'NS';

export interface DnsRecord {
  type: DnsRecordType;
  value: string;
  priority?: number;
  ttl?: number;
}


export interface DnsTransport {
  servers(): string[];
  query(name: string, type: DnsRecordType, options: { timeoutMs: number; signal: AbortSignal }): Promise<DnsRecord[]>;

  lookup(host: string, options: { signal: AbortSignal }): Promise<string[]>;
}

export class NodeDnsTransport implements DnsTransport {
  servers(): string[] {
    return new Resolver().getServers();
  }

  async query(name: string, type: DnsRecordType, options: { timeoutMs: number; signal: AbortSignal }): Promise<DnsRecord[]> {
    const resolver = new Resolver({ timeout: options.timeoutMs, tries: 1 });
    const onAbort = () => resolver.cancel();
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      switch (type) {
        case 'A':
          return (await resolver.resolve4(name, { ttl: true })).map((r) => ({ type, value: r.address, ttl: r.ttl }));
        case 'AAAA':
          return (await resolver.resolve6(name, { ttl: true })).map((r) => ({ type, value: r.address, ttl: r.ttl }));
        case 'MX':
          return (await resolver.resolveMx(name)).map((r) => ({ type, value: r.exchange, priority: r.priority }));
        case 'NS':
          return (await resolver.resolveNs(name)).map((value) => ({ type, value }));
      }
    } finally {
      options.signal.removeEventListener('abort', onAbort);
    }
  }

  async lookup(host: string, options: { signal: AbortSignal }): Promise<string[]> {
    options.signal.throwIfAborted();

    return new Promise<string[]>((resolve, reject) => {
      const onAbort = () => reject(options.signal.reason ?? new Error('aborted'));
      options.signal.addEventListener('abort', onAbort, { once: true });
      lookup(host, { all: true, verbatim: true })
        .then((addresses) => resolve(addresses.map((a) => a.address)), reject)
        .finally(() => options.signal.removeEventListener('abort', onAbort));
    });
  }
}

export interface TlsCertificateInfo {
  subject: Record<string, unknown> | null;
  issuer: Record<string, unknown> | null;
  validFrom: string | null;
  validTo: string | null;
  subjectAltName: string | null;
  fingerprint256: string | null;
  serialNumber: string | null;
}

export interface TlsProbeResult {
  authorized: boolean;
  authorizationError: string | null;
  protocol: string | null;
  certificate: TlsCertificateInfo | null;
}






export type TlsProbe = (
  address: string,
  port: number,
  options: { timeoutMs: number; signal: AbortSignal; servername: string },
) => Promise<TlsProbeResult>;

export const nodeTlsProbe: TlsProbe = (address, port, options) =>
  new Promise<TlsProbeResult>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(options.signal.reason ?? new Error('aborted'));
      return;
    }

    const socket = connect({
      host: address,
      port,
      servername: options.servername,

      checkServerIdentity: (_host, cert) => checkServerIdentity(options.servername, cert),
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      fn();
      socket.destroy();
    };
    const timer = setTimeout(
      () => finish(() => reject(Object.assign(new Error('TLS handshake timed out'), { code: 'ETIMEDOUT' }))),
      options.timeoutMs,
    );
    const onAbort = () => finish(() => reject(options.signal.reason ?? new Error('aborted')));
    options.signal.addEventListener('abort', onAbort, { once: true });
    socket.once('error', (error) => finish(() => reject(error)));
    socket.once('secureConnect', () =>
      finish(() => {
        const cert = socket.getPeerCertificate();
        const hasCert = cert && Object.keys(cert).length > 0;
        resolve({
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
          protocol: socket.getProtocol(),
          certificate: hasCert
            ? {
                subject: (cert.subject as unknown as Record<string, unknown>) ?? null,
                issuer: (cert.issuer as unknown as Record<string, unknown>) ?? null,
                validFrom: cert.valid_from ?? null,
                validTo: cert.valid_to ?? null,
                subjectAltName: cert.subjectaltname ?? null,
                fingerprint256: cert.fingerprint256 ?? null,
                serialNumber: cert.serialNumber ?? null,
              }
            : null,
        });
      }),
    );
  });

export interface HttpProbeRequest {
  method: 'HEAD' | 'GET';

  host: string;

  address: string;
  path: string;
  headers: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;

  maxBytes: number;
}

export interface HttpProbeResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bytesRead: number;
  truncated: boolean;
}


export type HttpProbe = (request: HttpProbeRequest) => Promise<HttpProbeResponse>;


export function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return ((_hostname: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as unknown as LookupFunction;
}

export const nodeHttpProbe: HttpProbe = (req) =>
  new Promise<HttpProbeResponse>((resolve, reject) => {
    if (req.signal.aborted) {
      reject(req.signal.reason ?? new Error('aborted'));
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onAbort);
      fn();
      outgoing.destroy();
    };

    const outgoing = httpsRequest({
      host: req.host,
      servername: req.host,
      port: 443,
      path: req.path,
      method: req.method,
      headers: { ...req.headers, host: req.host },
      lookup: pinnedLookup(req.address),
      agent: false,
    });
    const timer = setTimeout(
      () => finish(() => reject(Object.assign(new Error('HTTP request timed out'), { code: 'ETIMEDOUT' }))),
      req.timeoutMs,
    );
    const onAbort = () => finish(() => reject(req.signal.reason ?? new Error('aborted')));
    req.signal.addEventListener('abort', onAbort, { once: true });
    outgoing.once('error', (error) => finish(() => reject(error)));
    outgoing.once('response', (incoming) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
      let bytesRead = 0;
      let truncated = false;
      const done = () =>
        finish(() =>
          resolve({ status: incoming.statusCode ?? 0, statusText: incoming.statusMessage ?? '', headers, bytesRead, truncated }),
        );
      if (req.method === 'HEAD') {
        incoming.resume();
        done();
        return;
      }
      incoming.on('data', (chunk: Buffer) => {
        bytesRead += chunk.length;
        if (bytesRead >= req.maxBytes) {

          truncated = true;
          bytesRead = req.maxBytes;
          done();
        }
      });
      incoming.once('end', done);
      incoming.once('error', (error) => finish(() => reject(error)));
    });
    outgoing.end();
  });
