/** Backend origin for server-side forwarding. Read per request so `next start` picks up the env. */
export function backendUrl(): string {
  return (process.env.DOMAIN_SCOUT_BACKEND_URL || 'http://127.0.0.1:4317').replace(/\/+$/, '');
}

export const SESSION_COOKIE = 'ds_session';
export const CSRF_COOKIE = 'ds_csrf';
