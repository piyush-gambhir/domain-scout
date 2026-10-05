import { NextResponse, type NextRequest } from 'next/server';
import { CSRF_COOKIE, SESSION_COOKIE, backendUrl } from '@/lib/server/backend';

/*
 * Browser bootstrap: the launcher opens /auth/bootstrap?code=... with a single-use code. Exchange it
 * for a session, set the cookies and redirect with 303 so the code leaves the address bar.
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

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (!code) return redirect('/session?reason=expired');

  let session: SessionInfo;
  try {
    const response = await fetch(`${backendUrl()}/api/v1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
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
  const response = redirect('/scan');
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
