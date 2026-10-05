import { describe, expect, it } from 'vitest';
import { ApiRequestError, createClient, queryString } from '../src/index.js';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('api client', () => {
  it('builds paths, query strings and headers from the route table', async () => {
    const { fetch, calls } = fakeFetch(200, { contractVersion: '1.0.0', data: [], nextCursor: null, total: 0 });
    const client = createClient({ baseUrl: 'http://127.0.0.1:4317/', fetch, headers: () => ({ 'X-CSRF-Token': 't' }) });
    await client.call('listJobResults', {
      params: { id: '0f6d2c1e-4a3b-4c2d-9e8f-1a2b3c4d5e6f' },
      query: { outcomes: 'no_record,registered', limit: 50 },
    });
    expect(calls[0]!.url).toBe(
      'http://127.0.0.1:4317/api/v1/jobs/0f6d2c1e-4a3b-4c2d-9e8f-1a2b3c4d5e6f/results?outcomes=no_record%2Cregistered&limit=50',
    );
    expect(calls[0]!.init.method).toBe('GET');
    expect((calls[0]!.init.headers as Record<string, string>)['X-CSRF-Token']).toBe('t');
  });

  it('sends JSON bodies and idempotency keys', async () => {
    const { fetch, calls } = fakeFetch(201, { contractVersion: '1.0.0', data: {} });
    await createClient({ fetch }).call('createJob', {
      body: { type: 'registry_scan', input: { text: 'example.com' } },
      idempotencyKey: 'key-1',
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('key-1');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ type: 'registry_scan', input: { text: 'example.com' } });
  });

  it('raises the contract error body on failures', async () => {
    const error = { code: 'not_found', message: 'Job not found', requestId: 'r', domain: null, source: null, retryable: false, retryAt: null, details: null };
    const { fetch } = fakeFetch(404, { contractVersion: '1.0.0', error });
    const failure = await createClient({ fetch })
      .call('getJob', { params: { id: '0f6d2c1e-4a3b-4c2d-9e8f-1a2b3c4d5e6f' } })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiRequestError);
    expect((failure as ApiRequestError).status).toBe(404);
    expect((failure as ApiRequestError).body?.code).toBe('not_found');
  });

  it('refuses to read an event stream as JSON', async () => {
    const { fetch } = fakeFetch(200, {});
    await expect(createClient({ fetch }).call('streamEvents')).rejects.toThrow(/event stream/);
  });

  it('drops empty query values', () => {
    expect(queryString({ a: '', b: undefined, c: null, d: ['x', 'y'], e: 0 })).toBe('?d=x%2Cy&e=0');
  });
});
