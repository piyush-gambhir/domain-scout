import type { NextRequest } from 'next/server';
import { CONTRACT_VERSION } from '@domain-scout/contracts';
import { SESSION_COOKIE, backendUrl } from '@/lib/server/backend';

/*
 * Forwards /api/v1/* to the local backend. The browser never sees the API token: requests carry
 * only the HttpOnly session cookie, the CSRF header and the request headers the protocol needs.
 * Request and response bodies are streamed (SSE included) and nothing is cached or logged.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'x-csrf-token', 'idempotency-key', 'last-event-id', 'origin'];

// Hop-by-hop headers, encodings undone by fetch, and cookies (Next owns the session cookies).
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'set-cookie',
  'proxy-authenticate',
  'te',
  'trailer',
  'upgrade',
]);

type Context = { params: Promise<{ path: string[] }> };

/**
 * Next writes response headers only with the first body chunk. An SSE comment line (ignored by
 * EventSource) is sent first so the browser sees the stream open immediately instead of at the
 * first event or heartbeat. Upstream chunks then pass through unbuffered.
 */
function withStreamPrelude(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(': stream open\n\n'));
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function unavailable(status: number, message: string) {
  return Response.json(
    {
      contractVersion: CONTRACT_VERSION,
      error: {
        code: 'unavailable',
        message,
        requestId: crypto.randomUUID(),
        domain: null,
        source: null,
        retryable: true,
        retryAt: null,
        details: null,
      },
    },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

async function forward(request: NextRequest, context: Context): Promise<Response> {
  const { path } = await context.params;
  const target = new URL(`${backendUrl()}/api/v1/${path.map(encodeURIComponent).join('/')}`);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  // Re-encode so a crafted value cannot smuggle extra cookies past the allowlist.
  if (session) headers.set('cookie', `${SESSION_COOKIE}=${encodeURIComponent(session)}`);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      // Required by Node fetch to stream a request body.
      ...(hasBody ? { duplex: 'half' } : {}),
      signal: request.signal,
      redirect: 'manual',
      cache: 'no-store',
    } as RequestInit);
  } catch {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return unavailable(503, 'The local backend is not reachable.');
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
  });
  // no-transform keeps any intermediary from compressing (and so buffering) the event stream.
  responseHeaders.set('cache-control', 'no-store, no-transform');
  let body: ReadableStream<Uint8Array> | null = upstream.body;
  if (body && upstream.headers.get('content-type')?.startsWith('text/event-stream')) {
    responseHeaders.set('x-accel-buffering', 'no');
    body = withStreamPrelude(body);
  }

  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
