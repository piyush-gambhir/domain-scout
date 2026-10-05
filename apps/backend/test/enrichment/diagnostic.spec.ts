import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Diagnostic } from '@domain-scout/contracts';
import { isPublicAddress, isValidHostname } from '../../src/enrichment/address.js';
import { DiagnosticHandler, interpretDoh, parseDoh, parseSans } from '../../src/enrichment/diagnostic.handler.js';
import { pinnedLookup, type DnsTransport, type HttpProbe, type TlsProbe } from '../../src/enrichment/transports.js';
import {
  PUBLIC_ADDRESS,
  ctx,
  fakeDns,
  fakeFetch,
  fakeHttp,
  fakeTls,
  hang,
  item,
  json,
  noDns,
  noHttp,
  noTls,
  publicDns,
  settings,
  settingsService,
} from './fakes.js';

// DoH bodies follow the documented JSON format shared by Cloudflare and Google
// (https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/,
// https://developers.google.com/speed/public-dns/docs/doh/json). Reconstructions, October 2026.

let networkSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  networkSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network access in a unit test'));
});
afterEach(() => {
  expect(networkSpy).not.toHaveBeenCalled();
  networkSpy.mockRestore();
});

const doh = (type: number, answers: { name?: string; type?: number; data: string }[], extra: Record<string, unknown> = {}) =>
  json({ Status: 0, TC: false, RD: true, RA: true, AD: false, CD: false, Question: [{ name: 'example.com', type }], Answer: answers.map((a) => ({ name: a.name ?? 'example.com', type: a.type ?? type, TTL: 300, data: a.data })), ...extra });

function handler(options: { fetch?: ReturnType<typeof fakeFetch>['fetch']; dns?: DnsTransport; tls?: TlsProbe; http?: HttpProbe } = {}) {
  return new DiagnosticHandler(
    options.fetch ?? fakeFetch({}).fetch,
    options.dns ?? noDns,
    options.tls ?? noTls,
    options.http ?? noHttp,
    settingsService(),
  );
}

function diagnostic(result: Awaited<ReturnType<DiagnosticHandler['execute']>>) {
  const row = result.evidence[0];
  if (row?.kind !== 'observation') throw new Error('expected an observation');
  expect(row.row.kind).toBe('diagnostic');
  expect(row.row.payload).not.toHaveProperty('freshness');
  expect(row.row.payload.staleAt).toBe(row.row.staleAt);
  return { row: row.row, diag: Diagnostic.parse({ ...row.row.payload, freshness: 'fresh' }) };
}

describe('diagnostic handler: DNS over HTTPS', () => {
  it('parses A, AAAA and MX answers from Cloudflare and records the resolver', async () => {
    const { fetch, calls } = fakeFetch({
      'https://cloudflare-dns.com/dns-query?name=example.com&type=A': () =>
        doh(1, [{ type: 5, data: 'alias.example.net.' }, { data: '192.0.2.10' }, { data: '192.0.2.11' }], { AD: true }),
      'https://cloudflare-dns.com/dns-query?name=example.com&type=AAAA': () => doh(28, [{ data: '2001:db8::1' }]),
      'https://cloudflare-dns.com/dns-query?name=example.com&type=MX': () => doh(15, [{ data: '20 mx2.example.com.' }, { data: '10 mx1.example.com.' }]),
    });
    const h = handler({ fetch });
    const it_ = item('diagnostic', 'example.com', 'dns', { resolver: 'cloudflare' });
    expect(h.sourceKey(it_)).toBe('resolver:cloudflare');
    expect(h.destination(it_)).toBe('cloudflare-dns.com');
    const result = await h.execute(it_, ctx());
    expect(result).toMatchObject({ outcome: 'observed', resolved: true, error: null });
    const { row, diag } = diagnostic(result);
    expect(row).toMatchObject({ subject: 'example.com', suffix: 'com', sourceId: 'resolver:cloudflare', destination: 'cloudflare-dns.com', staleAt: '2026-10-05T12:15:00.000Z' });
    expect(diag.data).toMatchObject({
      resolver: 'cloudflare',
      endpoint: 'https://cloudflare-dns.com/dns-query',
      records: {
        A: ['192.0.2.10', '192.0.2.11'],
        AAAA: ['2001:db8::1'],
        MX: [
          { priority: 10, exchange: 'mx1.example.com' },
          { priority: 20, exchange: 'mx2.example.com' },
        ],
      },
      authenticatedData: true,
    });
    expect(calls.every((c) => c.headers.accept === 'application/dns-json')).toBe(true);
  });

  it('uses Google DoH for nameservers and strips trailing dots', async () => {
    const { fetch } = fakeFetch({
      'https://dns.google/resolve?name=example.com&type=NS': () => doh(2, [{ data: 'B.IANA-SERVERS.NET.' }, { data: 'a.iana-servers.net.' }]),
    });
    const result = await handler({ fetch }).execute(item('diagnostic', 'example.com', 'nameservers', { resolver: 'google' }), ctx());
    expect(diagnostic(result).diag).toMatchObject({ outcome: 'observed', destination: 'dns.google', data: { records: { NS: ['a.iana-servers.net', 'b.iana-servers.net'] } } });
  });

  it('reports a null MX (RFC 7505) explicitly', async () => {
    const { fetch } = fakeFetch({
      'https://cloudflare-dns.com/dns-query?name=example.com&type=MX': () => doh(15, [{ data: '0 .' }]),
      'https://cloudflare-dns.com/': () => doh(1, []),
    });
    const { diag } = diagnostic(await handler({ fetch }).execute(item('diagnostic', 'example.com', 'dns', { resolver: 'cloudflare' }), ctx()));
    expect(diag.data).toMatchObject({ records: { MX: [{ priority: 0, exchange: '.' }] }, nullMx: true });
  });

  it('maps NXDOMAIN (Status 3) to no_answer and stops querying further types', async () => {
    const { fetch, calls } = fakeFetch({ 'https://cloudflare-dns.com/': () => json({ Status: 3, AD: false, Question: [] }) });
    const result = await handler({ fetch }).execute(item('diagnostic', 'example.com', 'dns', { resolver: 'cloudflare' }), ctx());
    expect(result).toMatchObject({ outcome: 'no_answer', resolved: true });
    expect(diagnostic(result).diag.reason).toMatchObject({ code: 'nxdomain', message: expect.stringMatching(/not evidence that the domain is unregistered/) });
    expect(calls).toHaveLength(1);
  });

  it('maps NODATA for every type to no_answer and SERVFAIL to a retryable error', async () => {
    const empty = fakeFetch({ 'https://cloudflare-dns.com/': () => doh(1, []) });
    expect(await handler({ fetch: empty.fetch }).execute(item('diagnostic', 'example.com', 'dns', { resolver: 'cloudflare' }), ctx())).toMatchObject({ outcome: 'no_answer' });
    const servfail = fakeFetch({ 'https://cloudflare-dns.com/': () => json({ Status: 2 }) });
    const result = await handler({ fetch: servfail.fetch }).execute(item('diagnostic', 'example.com', 'nameservers', { resolver: 'cloudflare' }), ctx());
    expect(result).toMatchObject({ outcome: 'error', resolved: false, retryable: true, error: { code: 'dns_error' } });
    expect(diagnostic(result).diag.reason.message).toMatch(/SERVFAIL/);
  });

  it('reports DS and DNSKEY presence with the AD flag', async () => {
    const { fetch, calls } = fakeFetch({
      'https://cloudflare-dns.com/dns-query?name=example.com&type=DS': () => doh(43, [{ data: '370 13 2 BE74359954660069D5C63D200C39F5603827D7DD02B56F120EE9F3A86764247C' }], { AD: true }),
      'https://cloudflare-dns.com/dns-query?name=example.com&type=DNSKEY': () =>
        doh(48, [{ data: '257 3 13 mdsswUyr3DPW132mOi8V9xESWE8jTo0d==' }, { data: '256 3 13 oJMRESz5E4gYzS/q6XDrvU1qMPYIjCWz==' }, { type: 46, data: 'DNSKEY 13 2 3600 ...' }], { AD: true }),
    });
    const result = await handler({ fetch }).execute(item('diagnostic', 'example.com', 'dnssec', { resolver: 'cloudflare' }), ctx());
    const { diag } = diagnostic(result);
    expect(diag).toMatchObject({ outcome: 'observed', reason: { code: 'validated' } });
    expect(diag.data).toMatchObject({
      ds: [{ keyTag: 370, algorithm: 13, digestType: 2 }],
      dnskey: [
        { flags: 257, algorithm: 13, secureEntryPoint: true },
        { flags: 256, algorithm: 13, secureEntryPoint: false },
      ],
      authenticatedData: { DS: true, DNSKEY: true },
      signed: true,
      validated: true,
    });
    expect(calls.every((c) => c.url.endsWith('&do=1'))).toBe(true);
  });

  it('reports an unsigned zone when no DS record exists', async () => {
    const { fetch } = fakeFetch({ 'https://dns.google/': (url) => doh(url.includes('type=DS') ? 43 : 48, []) });
    const result = await handler({ fetch }).execute(item('diagnostic', 'example.com', 'dnssec', { resolver: 'google' }), ctx());
    expect(diagnostic(result).diag).toMatchObject({ outcome: 'observed', reason: { code: 'unsigned' }, data: { signed: false, validated: false } });
  });

  it('keeps partial answers observed, records per-type errors and stops after a rate limit', async () => {
    const { fetch, calls } = fakeFetch({
      'https://cloudflare-dns.com/dns-query?name=example.com&type=A': () => doh(1, [{ data: '192.0.2.10' }]),
      'https://cloudflare-dns.com/dns-query?name=example.com&type=AAAA': () => json({ error: 'slow down' }, 429, { 'retry-after': '30' }),
      'https://cloudflare-dns.com/dns-query?name=example.com&type=MX': () => doh(15, [{ data: '10 mx.example.com.' }]),
    });
    const result = await handler({ fetch }).execute(item('diagnostic', 'example.com', 'dns', { resolver: 'cloudflare' }), ctx());
    expect(calls.map((c) => c.url.split('type=')[1])).toEqual(['A', 'AAAA']);
    expect(result).toMatchObject({ outcome: 'observed', resolved: true, cooldownUntil: '2026-10-05T12:00:30.000Z', retryAt: null, error: null });
    expect(diagnostic(result).diag).toMatchObject({
      reason: { code: 'partial_answer' },
      data: {
        records: { A: ['192.0.2.10'], AAAA: [] },
        status: { A: 'ok', AAAA: 'error' },
        errors: { AAAA: { code: 'rate_limited' } },
        skipped: ['MX'],
      },
    });
  });

  it('keeps partial answers when one record type fails with SERVFAIL', async () => {
    const { fetch, calls } = fakeFetch({
      'https://dns.google/resolve?name=example.com&type=A': () => doh(1, [{ data: '192.0.2.10' }]),
      'https://dns.google/resolve?name=example.com&type=AAAA': () => json({ Status: 2 }),
      'https://dns.google/resolve?name=example.com&type=MX': () => doh(15, [{ data: '10 mx.example.com.' }]),
    });
    const result = await handler({ fetch }).execute(item('diagnostic', 'example.com', 'dns', { resolver: 'google' }), ctx());
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ outcome: 'observed', cooldownUntil: null });
    expect(diagnostic(result).diag.data).toMatchObject({
      records: { A: ['192.0.2.10'], MX: [{ priority: 10, exchange: 'mx.example.com' }] },
      errors: { AAAA: { code: 'dns_error', message: expect.stringMatching(/SERVFAIL/) } },
    });
  });

  it('records a cooldown and skips DNSKEY when the DS query is rate limited', async () => {
    const { fetch, calls } = fakeFetch({ 'https://cloudflare-dns.com/': () => new Response('', { status: 429 }) });
    const result = await handler({ fetch }).execute(item('diagnostic', 'example.com', 'dnssec', { resolver: 'cloudflare' }), ctx());
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ outcome: 'error', resolved: false, retryable: true, cooldownUntil: '2026-10-05T12:01:00.000Z', error: { code: 'rate_limited' } });
  });

  it('keeps the DNSKEY cooldown when DS fails for another reason', async () => {
    const { fetch, calls } = fakeFetch({
      'https://cloudflare-dns.com/dns-query?name=example.com&type=DS': () => json({ Status: 2 }),
      'https://cloudflare-dns.com/dns-query?name=example.com&type=DNSKEY': () => new Response('', { status: 429, headers: { 'retry-after': '90' } }),
    });
    const result = await handler({ fetch }).execute(item('diagnostic', 'example.com', 'dnssec', { resolver: 'cloudflare' }), ctx());
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({
      outcome: 'error',
      resolved: false,
      retryable: true,
      cooldownUntil: '2026-10-05T12:01:30.000Z',
      retryAt: '2026-10-05T12:01:30.000Z',
      error: { code: 'dns_error', message: expect.stringMatching(/SERVFAIL/) },
    });
  });

  it('does not follow a DoH redirect', async () => {
    const { fetch, calls } = fakeFetch({
      'https://cloudflare-dns.com/': () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.net/dns' } }),
    });
    const result = await handler({ fetch }).execute(item('diagnostic', 'example.com', 'nameservers', { resolver: 'cloudflare' }), ctx());
    expect(calls).toHaveLength(1);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
    expect(result).toMatchObject({ outcome: 'error', retryable: false, error: { code: 'unexpected_redirect', message: expect.stringContaining('elsewhere.example.net') } });
  });

  it('times out a hung resolver and records a retryable timeout', async () => {
    const { fetch } = fakeFetch({ 'https://cloudflare-dns.com/': hang });
    const result = await handler({ fetch }).execute(item('diagnostic', 'example.com', 'nameservers', { resolver: 'cloudflare' }), ctx({ settings: settings({ timeoutMs: 30 }) }));
    expect(result).toMatchObject({ outcome: 'timeout', resolved: false, retryable: true });
  });

  it('keeps sanitized raw DoH JSON only when raw diagnostics are enabled', async () => {
    const routes = { 'https://cloudflare-dns.com/': () => doh(2, [{ data: 'ns1.example.com.' }]) };
    const off = await handler({ fetch: fakeFetch(routes).fetch }).execute(item('diagnostic', 'example.com', 'nameservers', { resolver: 'cloudflare' }), ctx());
    expect(diagnostic(off).row.raw).toBeNull();
    const on = await handler({ fetch: fakeFetch(routes).fetch }).execute(item('diagnostic', 'example.com', 'nameservers', { resolver: 'cloudflare' }), ctx({ settings: settings({ keepRaw: true }) }));
    expect(diagnostic(on).row.raw).toMatchObject({ contentType: 'application/dns-json', truncated: false, body: expect.stringContaining('ns1.example.com.') });
  });

  it('exposes pure parsers for malformed input', () => {
    expect(parseDoh('not json')).toBeNull();
    expect(parseDoh('{"Answer":[]}')).toBeNull();
    expect(interpretDoh({ Status: 0 }, 'A')).toMatchObject({ status: 'nodata', records: [] });
    expect(parseSans('DNS:example.com, DNS:www.example.com, IP Address:192.0.2.1')).toEqual(['example.com', 'www.example.com', 'IP Address:192.0.2.1']);
  });
});

describe('diagnostic handler: system resolver', () => {
  it('queries the OS resolver through the transport and records its servers', async () => {
    const dns = fakeDns({
      A: [{ type: 'A', value: '192.0.2.10' }],
      AAAA: { code: 'ENODATA' },
      MX: [{ type: 'MX', value: 'mail.example.com', priority: 5 }],
    });
    const h = handler({ dns });
    const it_ = item('diagnostic', 'example.com', 'dns', {});
    expect(h.sourceKey(it_)).toBe('resolver:system');
    const result = await h.execute(it_, ctx());
    expect(dns.calls).toEqual(['example.com A', 'example.com AAAA', 'example.com MX']);
    expect(diagnostic(result).diag).toMatchObject({
      outcome: 'observed',
      destination: 'system resolver (192.0.2.53)',
      data: { resolver: 'system', servers: ['192.0.2.53'], records: { A: ['192.0.2.10'], AAAA: [], MX: [{ priority: 5, exchange: 'mail.example.com' }] }, status: { AAAA: 'nodata' }, authenticatedData: null },
    });
  });

  it('maps ENOTFOUND to no_answer and ETIMEOUT to timeout', async () => {
    const missing = await handler({ dns: fakeDns({ NS: { code: 'ENOTFOUND' } }) }).execute(item('diagnostic', 'example.com', 'nameservers'), ctx());
    expect(missing).toMatchObject({ outcome: 'no_answer', resolved: true });
    const slow = await handler({ dns: fakeDns({ NS: { code: 'ETIMEOUT' } }) }).execute(item('diagnostic', 'example.com', 'nameservers'), ctx());
    expect(slow).toMatchObject({ outcome: 'timeout', resolved: false, retryable: true });
  });

  it('reports dnssec as unsupported for the system resolver without any request', async () => {
    const { fetch } = fakeFetch({});
    const dns = fakeDns({});
    const h = handler({ fetch, dns });
    const it_ = item('diagnostic', 'example.com', 'dnssec', { resolver: 'system' });
    expect(h.sourceKey(it_)).toBeNull();
    const result = await h.execute(it_, ctx());
    expect(result).toMatchObject({ outcome: 'error', resolved: false, error: { code: 'unsupported_resolver' } });
    expect(fetch).not.toHaveBeenCalled();
    expect(dns.calls).toEqual([]);
  });

  it('falls back to the settings resolver when the job input has none', async () => {
    const { fetch } = fakeFetch({ 'https://dns.google/': () => doh(2, [{ data: 'ns.example.com.' }]) });
    const h = new DiagnosticHandler(fetch, noDns, noTls, noHttp, settingsService(settings({ resolver: 'google' })));
    const it_ = item('diagnostic', 'example.com', 'nameservers');
    expect(h.sourceKey(it_)).toBe('resolver:google');
    expect(await h.execute(it_, ctx({ settings: settings({ resolver: 'google' }) }))).toMatchObject({ outcome: 'observed' });
  });
});

describe('diagnostic handler: TLS', () => {
  const cert = {
    subject: { CN: 'example.com' },
    issuer: { C: 'US', O: 'Example CA', CN: 'Example CA R1' },
    validFrom: 'Jan 15 00:00:00 2026 GMT',
    validTo: 'Jan 15 23:59:59 2027 GMT',
    subjectAltName: 'DNS:example.com, DNS:www.example.com',
    fingerprint256: 'AA:BB',
    serialNumber: '01',
  };

  it('records certificate fields for a trusted certificate, pinned to the vetted address', async () => {
    const tls = fakeTls({ authorized: true, authorizationError: null, protocol: 'TLSv1.3', certificate: cert });
    const dns = publicDns();
    const h = handler({ tls, dns });
    const it_ = item('diagnostic', 'example.com', 'tls');
    expect(h.sourceKey(it_)).toBe('host:example.com');
    const result = await h.execute(it_, ctx());
    expect(dns.calls).toEqual(['example.com lookup']);
    expect(tls.calls).toEqual([`${PUBLIC_ADDRESS}:443 sni=example.com`]);
    const { row, diag } = diagnostic(result);
    expect(row.sourceId).toBe('host:example.com');
    expect(diag).toMatchObject({
      outcome: 'observed',
      destination: 'example.com:443',
      reason: { code: 'certificate_trusted' },
      data: {
        protocol: 'TLSv1.3',
        address: PUBLIC_ADDRESS,
        authorized: true,
        subjectCommonName: 'example.com',
        issuerCommonName: 'Example CA R1',
        validFrom: '2026-01-15T00:00:00.000Z',
        validTo: '2027-01-15T23:59:59.000Z',
        subjectAltNames: ['example.com', 'www.example.com'],
      },
    });
  });

  it('still observes an untrusted certificate and reports why', async () => {
    const tls = fakeTls({ authorized: false, authorizationError: 'Error: certificate has expired', protocol: 'TLSv1.2', certificate: cert });
    const { diag } = diagnostic(await handler({ tls, dns: publicDns() }).execute(item('diagnostic', 'example.com', 'tls'), ctx()));
    expect(diag).toMatchObject({ outcome: 'observed', reason: { code: 'certificate_untrusted', message: expect.stringMatching(/expired/) }, data: { authorized: false } });
  });

  it.each([
    ['ECONNREFUSED', 'unreachable'],
    ['ETIMEDOUT', 'timeout'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'error'],
  ])('maps a %s handshake failure to %s', async (code, outcome) => {
    const result = await handler({ tls: fakeTls({ code }), dns: publicDns() }).execute(item('diagnostic', 'example.com', 'tls'), ctx());
    expect(result).toMatchObject({ outcome, resolved: false });
  });

  it('maps a failed address lookup to unreachable without connecting', async () => {
    const tls = fakeTls({ code: 'ECONNREFUSED' });
    const result = await handler({ tls, dns: fakeDns({}, { code: 'ENOTFOUND' }) }).execute(item('diagnostic', 'example.com', 'tls'), ctx());
    expect(result).toMatchObject({ outcome: 'unreachable', resolved: false });
    expect(tls.calls).toEqual([]);
  });

  it('tries the IPv6 address when the IPv4 address is unreachable', async () => {
    const calls: string[] = [];
    const tls = (async (address: string) => {
      calls.push(address);
      if (address === PUBLIC_ADDRESS) throw Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' });
      return { authorized: true, authorizationError: null, protocol: 'TLSv1.3', certificate: cert };
    }) as TlsProbe;
    const dns = publicDns(['2606:2800:21f:cb07:6820:80da:af6b:8b2c', PUBLIC_ADDRESS]);
    const result = await handler({ tls, dns }).execute(item('diagnostic', 'example.com', 'tls'), ctx());
    expect(calls).toEqual([PUBLIC_ADDRESS, '2606:2800:21f:cb07:6820:80da:af6b:8b2c']);
    expect(diagnostic(result).diag.data).toMatchObject({ address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c' });
  });
});

describe('diagnostic handler: HTTP', () => {
  it('sends HEAD pinned to the vetted address and records the redirect without following it', async () => {
    const { http, calls } = fakeHttp(() => ({ status: 301, statusText: 'Moved Permanently', headers: { location: '/en/', server: 'ExampleServer' } }));
    const h = handler({ http, dns: publicDns() });
    const it_ = item('diagnostic', 'example.com', 'http');
    expect(h.sourceKey(it_)).toBe('host:example.com');
    expect(h.destination(it_)).toBe('https://example.com/');
    const { diag } = diagnostic(await h.execute(it_, ctx()));
    expect(calls).toEqual([{ method: 'HEAD', host: 'example.com', address: PUBLIC_ADDRESS, path: '/' }]);
    expect(diag).toMatchObject({
      outcome: 'observed',
      data: {
        method: 'HEAD',
        status: 301,
        redirect: true,
        location: '/en/',
        resolvedLocation: 'https://example.com/en/',
        server: 'ExampleServer',
        address: PUBLIC_ADDRESS,
        headFallback: null,
        bytesRead: null,
      },
    });
  });

  it('connects to the vetted address even if a later lookup would return a private one', async () => {
    let lookups = 0;
    const dns: DnsTransport & { calls: string[] } = {
      calls: [],
      servers: () => [],
      query: () => Promise.reject(new Error('unexpected DNS query')),
      // A rebinding resolver: public on the first answer, loopback afterwards.
      lookup: async () => (lookups++ === 0 ? [PUBLIC_ADDRESS] : ['127.0.0.1']),
    };
    const { http, calls } = fakeHttp((request) => (request.method === 'HEAD' ? { status: 405 } : { status: 200 }));
    const result = await handler({ http, dns }).execute(item('diagnostic', 'example.com', 'http'), ctx());
    expect(result.outcome).toBe('observed');
    expect(lookups).toBe(1);
    expect(calls.map((c) => [c.method, c.address])).toEqual([
      ['HEAD', PUBLIC_ADDRESS],
      ['GET', PUBLIC_ADDRESS],
    ]);
  });

  it('tries the vetted IPv6 address when IPv4 is unreachable, without resolving again', async () => {
    const v6 = '2606:2800:21f:cb07:6820:80da:af6b:8b2c';
    const dns = publicDns([PUBLIC_ADDRESS, v6]);
    const { http, calls } = fakeHttp((request) => (request.address === PUBLIC_ADDRESS ? { code: 'ENETUNREACH' } : { status: 200 }));
    const { diag } = diagnostic(await handler({ http, dns }).execute(item('diagnostic', 'example.com', 'http'), ctx()));
    expect(diag.outcome).toBe('observed');
    expect(calls.map((c) => [c.method, c.address])).toEqual([
      ['HEAD', PUBLIC_ADDRESS],
      ['HEAD', v6],
    ]);
    expect(diag.data).toMatchObject({ address: v6 });
  });

  it('pins the socket lookup to one address for single and all-address requests', () => {
    const lookup = pinnedLookup(PUBLIC_ADDRESS) as unknown as (host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => void;
    const single = vi.fn();
    lookup('example.com', {}, single);
    expect(single).toHaveBeenCalledWith(null, PUBLIC_ADDRESS, 4);
    const all = vi.fn();
    lookup('example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: PUBLIC_ADDRESS, family: 4 }]);
  });

  it('falls back to a bounded GET when HEAD is not allowed', async () => {
    const { http, calls } = fakeHttp((request) =>
      request.method === 'HEAD'
        ? { status: 405 }
        : { status: 200, headers: { 'content-type': 'text/html' }, bytesRead: request.maxBytes, truncated: true },
    );
    const { diag } = diagnostic(await handler({ http, dns: publicDns() }).execute(item('diagnostic', 'example.com', 'http'), ctx()));
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'GET']);
    expect(diag.data).toMatchObject({ method: 'GET', status: 200, headFallback: 'HEAD returned 405', bytesRead: 64 * 1024, truncated: true, contentType: 'text/html' });
  });

  it('falls back to GET when HEAD fails, then reports unreachable when GET also fails', async () => {
    const { http, calls } = fakeHttp(() => ({ code: 'ECONNREFUSED' }));
    const result = await handler({ http, dns: publicDns() }).execute(item('diagnostic', 'example.com', 'http'), ctx());
    expect(calls.map((c) => c.method)).toEqual(['HEAD', 'GET']);
    expect(result).toMatchObject({ outcome: 'unreachable', resolved: false, retryable: false });
  });

  it('reports certificate failures as errors', async () => {
    const { http } = fakeHttp(() => ({ code: 'CERT_HAS_EXPIRED' }));
    const result = await handler({ http, dns: publicDns() }).execute(item('diagnostic', 'example.com', 'http'), ctx());
    expect(result).toMatchObject({ outcome: 'error', resolved: false, error: { code: 'cert_has_expired' } });
  });

  it('times out without a GET retry when HEAD hangs', async () => {
    const { http, calls } = fakeHttp(() => 'hang');
    const result = await handler({ http, dns: publicDns() }).execute(item('diagnostic', 'example.com', 'http'), ctx({ settings: settings({ timeoutMs: 30 }) }));
    expect(result).toMatchObject({ outcome: 'timeout', retryable: true });
    expect(calls).toHaveLength(1);
  });

  it('keeps response headers without cookies as raw diagnostics only when enabled', async () => {
    const { http } = fakeHttp(() => ({ status: 200, headers: { server: 'ExampleServer', 'set-cookie': 'session=secret' } }));
    const on = await handler({ http, dns: publicDns() }).execute(item('diagnostic', 'example.com', 'http'), ctx({ settings: settings({ keepRaw: true }) }));
    const raw = diagnostic(on).row.raw;
    expect(raw?.body).toContain('server: ExampleServer');
    expect(raw?.body).not.toContain('secret');
  });

  it('never writes registry evidence', async () => {
    const { http } = fakeHttp(() => ({ status: 404 }));
    const result = await handler({ http, dns: publicDns() }).execute(item('diagnostic', 'example.com', 'http'), ctx());
    expect(result.evidence.every((e) => e.kind === 'observation' && e.row.kind === 'diagnostic')).toBe(true);
  });
});

describe('diagnostic handler: connection targets', () => {
  it.each([
    ['loopback', ['127.0.0.1']],
    ['RFC 1918', ['10.1.2.3']],
    ['link-local metadata', ['169.254.169.254']],
    ['CGNAT', ['100.64.0.1']],
    ['IPv6 loopback', ['::1']],
    ['unique-local IPv6', ['fd00::1']],
    ['IPv4-mapped loopback', ['::ffff:127.0.0.1']],
    ['one private among public addresses', [PUBLIC_ADDRESS, '192.168.1.10']],
  ])('refuses TLS and HTTP when the domain resolves to a %s address', async (_label, addresses) => {
    const tls = fakeTls({ authorized: true, authorizationError: null, protocol: 'TLSv1.3', certificate: null });
    const { http } = fakeHttp(() => ({ status: 200 }));
    const { fetch } = fakeFetch({});
    for (const check of ['tls', 'http']) {
      const result = await handler({ fetch, tls, http, dns: publicDns(addresses) }).execute(item('diagnostic', 'internal.example', check), ctx());
      expect(result).toMatchObject({ outcome: 'error', resolved: false, error: { code: 'non_public_address' } });
      expect(diagnostic(result).diag.data).toMatchObject({ addresses });
    }
    expect(tls.calls).toEqual([]);
    expect(http).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses invalid host names and IP literals without any lookup', async () => {
    const dns = publicDns();
    const { http } = fakeHttp(() => ({ status: 200 }));
    for (const name of ['127.0.0.1', 'localhost', '-bad-.example', 'under_score.example']) {
      const result = await handler({ http, dns }).execute(item('diagnostic', name, 'http'), ctx());
      expect(result).toMatchObject({ outcome: 'error', error: { code: 'invalid_domain' } });
    }
    expect(dns.calls).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it('classifies addresses', () => {
    for (const address of [PUBLIC_ADDRESS, '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPublicAddress(address), address).toBe(true);
    for (const address of [
      '0.0.0.0',
      '127.0.0.53',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.1.1',
      '100.127.255.255',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:10.0.0.1',
      'not-an-ip',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isValidHostname('example.com')).toBe(true);
    expect(isValidHostname('xn--bcher-kva.example')).toBe(true);
    expect(isValidHostname('1.2.3.4')).toBe(false);
    expect(isValidHostname('example.123')).toBe(false);
  });
});
