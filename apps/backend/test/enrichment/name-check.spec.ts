import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NameCheck } from '@domain-scout/contracts';
import { NameCheckHandler } from '../../src/enrichment/name-check.handler.js';
import { serviceManifest } from '../../src/enrichment/name-check.services.js';
import { ctx, fakeFetch, hang, item, json, settings } from './fakes.js';

// Response bodies are documentation-derived reconstructions (GitHub REST "Get a user", npm registry
// abbreviated metadata, PyPI JSON API, crates.io API), trimmed to the fields the parser reads. October 2026.

let networkSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  networkSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network access in a unit test'));
});
afterEach(() => {
  expect(networkSpy).not.toHaveBeenCalled();
  networkSpy.mockRestore();
});

function payload(result: Awaited<ReturnType<NameCheckHandler['execute']>>) {
  const row = result.evidence[0];
  if (row?.kind !== 'observation') throw new Error('expected an observation');
  // Freshness is computed at read time, so the stored payload omits it and matches the row's stale_at.
  expect(row.row.payload).not.toHaveProperty('freshness');
  expect(row.row.payload.staleAt).toBe(row.row.staleAt);
  return { row: row.row, check: NameCheck.parse({ ...row.row.payload, freshness: 'fresh' }) };
}

describe('name_check handler', () => {
  it('maps GitHub 200 to exists with type detail and records the source', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/users/': () => json({ login: 'Octo-Org', id: 1, type: 'Organization' }),
    });
    const handler = new NameCheckHandler(fetch);
    const it_ = item('name_check', 'octo-org', 'github');
    expect(handler.sourceKey(it_)).toBe('service:github');
    expect(handler.destination(it_)).toBe('api.github.com');
    const result = await handler.execute(it_, ctx());
    expect(result).toMatchObject({ outcome: 'exists', resolved: true, error: null });
    const { row, check } = payload(result);
    expect(row).toMatchObject({ kind: 'name_check', subject: 'octo-org', suffix: null, sourceId: 'service:github', destination: 'api.github.com', outcome: 'exists' });
    expect(row.staleAt).toBe('2026-10-05T12:15:00.000Z');
    expect(check).toMatchObject({ service: 'github', namespace: 'GitHub user or organization login', httpStatus: 200, detail: { type: 'Organization', login: 'Octo-Org' } });
    expect(calls[0]!.url).toBe('https://api.github.com/users/octo-org');
    expect(calls[0]!.headers.accept).toBe('application/vnd.github+json');
    expect(calls[0]!.headers['user-agent']).toMatch(/DomainScout/);
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('maps 404 to not_found without claiming the name is claimable', async () => {
    const { fetch } = fakeFetch({ 'https://api.github.com/': () => json({ message: 'Not Found' }, 404) });
    const result = await new NameCheckHandler(fetch).execute(item('name_check', 'nobody-here', 'github'), ctx());
    expect(result).toMatchObject({ outcome: 'not_found', resolved: true });
    expect(payload(result).check.reason.message).toMatch(/does not mean the name can be claimed/);
  });

  it.each([
    ['403 with x-ratelimit-reset', 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.parse('2026-10-05T12:30:00Z') / 1000) }, '2026-10-05T12:30:00.000Z'],
    ['429 with retry-after seconds', 429, { 'retry-after': '120' }, '2026-10-05T12:02:00.000Z'],
    ['403 without headers', 403, {}, '2026-10-05T12:01:00.000Z'],
  ])('maps GitHub %s to rate_limited with a cooldown', async (_label, status, headers, until) => {
    const { fetch } = fakeFetch({ 'https://api.github.com/': () => json({ message: 'API rate limit exceeded' }, status, headers) });
    const result = await new NameCheckHandler(fetch).execute(item('name_check', 'octocat', 'github'), ctx());
    expect(result).toMatchObject({ outcome: 'rate_limited', resolved: false, retryable: true, cooldownUntil: until, retryAt: until });
    expect(result.error).toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('reads the npm latest-version manifest and encodes scoped names', async () => {
    const { fetch, calls } = fakeFetch({
      'https://registry.npmjs.org/': (url) =>
        json({ name: decodeURIComponent(url.slice('https://registry.npmjs.org/'.length, -'/latest'.length)), version: '19.2.0', main: 'index.js' }),
    });
    const handler = new NameCheckHandler(fetch);
    const plain = await handler.execute(item('name_check', 'react', 'npm'), ctx());
    expect(payload(plain).check.detail).toEqual({ latestVersion: '19.2.0' });
    const scoped = await handler.execute(item('name_check', '@types/node', 'npm'), ctx());
    expect(scoped.outcome).toBe('exists');
    expect(calls.map((c) => c.url)).toEqual(['https://registry.npmjs.org/react/latest', 'https://registry.npmjs.org/@types%2Fnode/latest']);
    expect(calls[0]!.headers.accept).toBe('application/json');
  });

  // Large crates.io and PyPI documents exceed the 1 MB bound; identity is read from the prefix.
  const bigCrate = (name: string) => {
    const versions = Array.from({ length: 20_000 }, (_, i) => ({ num: `1.0.${i}`, crate: name, dl_path: `/api/v1/crates/${name}/1.0.${i}/download` }));
    return json({ crate: { id: name, name, max_version: '1.0.19999' }, versions });
  };

  it('bounds large bodies and verifies identity from the truncated prefix', async () => {
    const { fetch } = fakeFetch({ 'https://crates.io/': () => bigCrate('big') });
    const result = await new NameCheckHandler(fetch).execute(item('name_check', 'big', 'crates'), ctx());
    expect(result.outcome).toBe('exists');
    expect(payload(result).check.detail).toEqual({ crateName: 'big', maxVersion: '1.0.19999', truncated: true });
  });

  it('rejects a truncated body that names a different record', async () => {
    const { fetch } = fakeFetch({ 'https://crates.io/': () => bigCrate('other') });
    const result = await new NameCheckHandler(fetch).execute(item('name_check', 'big', 'crates'), ctx());
    expect(result).toMatchObject({ outcome: 'error', resolved: false, error: { code: 'response_mismatch' } });
    expect(payload(result).check.reason.message).toContain('other');
  });

  it.each([
    ['an empty body', () => new Response('', { status: 200 })],
    ['an HTML maintenance page', () => new Response('<html><body>Down for maintenance</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['JSON without the identity field', () => json({ message: 'ok' })],
  ])('does not treat a 200 with %s as existence', async (_label, respond) => {
    const { fetch } = fakeFetch({ 'https://api.github.com/': respond });
    const result = await new NameCheckHandler(fetch).execute(item('name_check', 'octocat', 'github'), ctx());
    expect(result).toMatchObject({ outcome: 'error', resolved: false, retryable: true, error: { code: 'unverifiable_response', retryable: true } });
  });

  it('never follows redirects and reports the redirect host', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/': () => new Response(null, { status: 301, headers: { location: 'https://evil.example.net/users/octocat' } }),
    });
    const result = await new NameCheckHandler(fetch).execute(item('name_check', 'octocat', 'github'), ctx());
    expect(result).toMatchObject({ outcome: 'error', resolved: false, retryable: false, error: { code: 'unexpected_redirect', retryable: false } });
    expect(payload(result).check.reason.message).toContain('evil.example.net');
    expect(calls).toHaveLength(1);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows one same-host PyPI canonical-name redirect and verifies the target body', async () => {
    const { fetch, calls } = fakeFetch({
      'https://pypi.org/pypi/django/json': () => new Response(null, { status: 301, headers: { location: '/pypi/Django/json' } }),
      'https://pypi.org/pypi/Django/json': () => json({ info: { name: 'Django', version: '5.2.7' } }),
    });
    const result = await new NameCheckHandler(fetch).execute(item('name_check', 'django', 'pypi'), ctx());
    expect(result).toMatchObject({ outcome: 'exists', resolved: true });
    expect(payload(result).check.detail).toEqual({ projectName: 'Django', latestVersion: '5.2.7' });
    expect(calls.map((c) => c.url)).toEqual(['https://pypi.org/pypi/django/json', 'https://pypi.org/pypi/Django/json']);
    expect(fetch.mock.calls.every((c) => c[1]?.redirect === 'manual')).toBe(true);
  });

  it.each([
    ['a different project', 'https://pypi.org/pypi/other/json', () => json({})],
    ['another host', 'https://files.example.net/pypi/Django/json', () => json({})],
    ['a second redirect', 'https://pypi.org/pypi/Django/json', () => new Response(null, { status: 301, headers: { location: '/pypi/DJANGO/json' } })],
    ['a malformed escape', 'https://pypi.org/pypi/Django%ZZ/json', () => json({})],
  ])('does not accept a PyPI redirect to %s', async (_label, location, target) => {
    const { fetch, calls } = fakeFetch({
      'https://pypi.org/pypi/django/json': () => new Response(null, { status: 302, headers: { location } }),
      'https://pypi.org/pypi/Django/json': target,
    });
    const result = await new NameCheckHandler(fetch).execute(item('name_check', 'django', 'pypi'), ctx());
    expect(result).toMatchObject({ outcome: 'error', resolved: false, error: { code: 'unexpected_redirect' } });
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it('does not count a canonical redirect whose target body is unverifiable', async () => {
    const { fetch } = fakeFetch({
      'https://pypi.org/pypi/django/json': () => new Response(null, { status: 301, headers: { location: '/pypi/Django/json' } }),
      'https://pypi.org/pypi/Django/json': () => new Response('<html>maintenance</html>', { status: 200 }),
    });
    const result = await new NameCheckHandler(fetch).execute(item('name_check', 'django', 'pypi'), ctx());
    expect(result).toMatchObject({ outcome: 'error', error: { code: 'unverifiable_response' } });
  });

  it('rethrows when the job is cancelled instead of recording evidence', async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch({ 'https://registry.npmjs.org/': hang });
    const pending = new NameCheckHandler(fetch).execute(item('name_check', 'react', 'npm'), ctx({ signal: controller.signal }));
    controller.abort(new Error('job cancelled'));
    await expect(pending).rejects.toThrow('job cancelled');
  });

  it.each(['x', 'instagram', 'tiktok', 'linkedin', 'youtube', 'reddit'])('marks %s unsupported without a request', async (service) => {
    const { fetch } = fakeFetch({});
    const handler = new NameCheckHandler(fetch);
    const it_ = item('name_check', 'brand', service);
    expect(handler.sourceKey(it_)).toBeNull();
    expect(handler.destination(it_)).toBeNull();
    const result = await handler.execute(it_, ctx());
    expect(result).toMatchObject({ outcome: 'unsupported', resolved: false, retryable: false, error: { code: 'unsupported_service', retryable: false } });
    expect(payload(result).check).toMatchObject({ service, destination: null, httpStatus: null, reason: { code: 'unsupported_service' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['github', '-leading'],
    ['github', 'a'.repeat(40)],
    ['github', 'double--hyphen'],
    ['npm', 'UpperCase'],
    ['npm', '.hidden'],
    ['npm', 'has space'],
    ['npm', 'a'.repeat(215)],
    ['pypi', '-bad-'],
    ['pypi', 'no spaces'],
    ['crates', '1starts-with-digit'],
    ['crates', 'a'.repeat(65)],
  ])('rejects invalid %s name %s without a request', async (service, name) => {
    const { fetch } = fakeFetch({});
    const result = await new NameCheckHandler(fetch).execute(item('name_check', name, service), ctx());
    expect(result).toMatchObject({ outcome: 'error', resolved: false, retryable: false, error: { code: 'invalid_name' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('publishes a manifest of all ten services', () => {
    const manifest = serviceManifest();
    expect(manifest.map((s) => s.id).sort()).toEqual(['crates', 'github', 'instagram', 'linkedin', 'npm', 'pypi', 'reddit', 'tiktok', 'x', 'youtube']);
    for (const s of manifest) {
      if (s.supported) expect(s).toMatchObject({ destination: expect.any(String), reason: null });
      else expect(s).toMatchObject({ destination: null, reason: expect.stringMatching(/not scraped/) });
    }
  });
});
