import { NextResponse, type NextRequest } from 'next/server';
import { CSRF_COOKIE, SESSION_COOKIE, backendUrl } from '@/lib/server/backend';

/*
 * Browser bootstrap: the launcher opens /auth/bootstrap?code=...[&next=/search/<id>] with a single-use
 * code. Exchange it for a session, set the cookies and redirect with 303 so the code leaves the
 * address bar. `next` is honored only as a same-origin path.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SessionInfo {
  sessionId: string;
  csrfToken: string;
  expiresAt: string;
}

function redirect(location: string) {
  return new NextResponse(null, {
    status: 303,
    headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
}

/** A same-origin path to open after sign-in: one leading slash, no scheme, host or backslash tricks. */
function safeNext(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  try {
    const base = 'http://ds.invalid';
    const url = new URL(value, base);
    // Check the normalized path too: "/a/..//host" resolves to "//host", a protocol-relative redirect.
    if (url.origin !== base || url.pathname.startsWith('//') || url.pathname.includes('\\')) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const next = safeNext(request.nextUrl.searchParams.get('next'));
  if (!code) return redirect('/session?reason=expired');

  let session: SessionInfo;
  try {
    const response = await fetch(`${backendUrl()}/api/v1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-domain-scout-client': 'web' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
    });
    if (!response.ok) return redirect('/session?reason=expired');
    const body = (await response.json()) as { data?: SessionInfo };
    if (!body.data?.sessionId || !body.data.csrfToken) return redirect('/session?reason=expired');
    session = body.data;
  } catch {
    return redirect('/session?reason=unavailable');
  }

  const expires = new Date(session.expiresAt);
  const validExpiry = !Number.isNaN(expires.getTime());
  const response = redirect(next);
  response.cookies.set(SESSION_COOKIE, session.sessionId, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    ...(validExpiry ? { expires } : {}),
  });
  // Readable by browser JavaScript so it can echo the token in X-CSRF-Token on mutations.
  response.cookies.set(CSRF_COOKIE, session.csrfToken, {
    httpOnly: false,
    sameSite: 'strict',
    path: '/',
    ...(validExpiry ? { expires } : {}),
  });
  return response;
}
