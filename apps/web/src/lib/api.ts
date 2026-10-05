import { ApiRequestError, createClient } from '@domain-scout/api-client';

export { ApiRequestError };

const CSRF_COOKIE = 'ds_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return part.slice(index + 1).trim();
      }
    }
  }
  return null;
}

/** Adds the session's CSRF token (readable ds_csrf cookie) to mutating requests. */
const csrfFetch: typeof fetch = (input, init = {}) => {
  const method = (init.method ?? 'GET').toUpperCase();
  if (!SAFE_METHODS.has(method)) {
    const token = readCookie(CSRF_COOKIE);
    if (token) {
      const headers = new Headers(init.headers);
      headers.set('X-CSRF-Token', token);
      init = { ...init, headers };
    }
  }
  return fetch(input, init);
};

/** Same-origin client: Next forwards /api/v1/* to the backend with the session cookie. */
export const api = createClient({ baseUrl: '', fetch: csrfFetch, credentials: 'same-origin' });

/** One key per user-initiated submission, so a replayed request never starts a second job. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.body?.message) return error.body.message;
    if (error.status === 503) return 'The local backend is not reachable.';
    return `Request failed (HTTP ${error.status}).`;
  }
  if (error instanceof Error) {
    if (error.name === 'TypeError') return 'The local server is not reachable.';
    return error.message;
  }
  return 'Something went wrong.';
}
