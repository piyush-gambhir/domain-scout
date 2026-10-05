import { ProviderTransport, TransportError, type ProviderHttpRequest, type ProviderHttpResponse } from '../transport.js';
import { ProviderError } from './types.js';

export interface HttpOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  now: () => Date;
  /** Secret values to scrub from any message that could surface (errors, reasons). */
  secrets: string[];
}

/**
 * Transport bound to one adapter call: applies the timeout and cancellation signal, maps network
 * failures to ProviderError and scrubs secrets from every message it produces.
 */
export class ProviderHttp {
  constructor(
    private readonly transport: ProviderTransport,
    private readonly options: HttpOptions,
  ) {}

  async request(request: Omit<ProviderHttpRequest, 'timeoutMs' | 'signal'>): Promise<ProviderHttpResponse> {
    try {
      return await this.transport.send({ ...request, timeoutMs: this.options.timeoutMs, signal: this.options.signal });
    } catch (error) {
      if (error instanceof TransportError) {
        const kind = error.kind === 'too_large' || error.kind === 'redirect' ? 'bad_response' : 'transient';
        throw new ProviderError(kind, this.scrub(error.message));
      }
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('transient', this.scrub((error as Error)?.message ?? 'Request failed'));
    }
  }

  /** Replaces every configured secret (and its URL-encoded form) with a placeholder. */
  scrub(text: string): string {
    let out = text;
    for (const secret of this.options.secrets) {
      if (!secret || secret.length < 4) continue;
      for (const form of new Set([secret, encodeURIComponent(secret)])) out = out.split(form).join('[redacted]');
    }
    return out;
  }

  now(): Date {
    return this.options.now();
  }

  /** Retry-After (seconds or HTTP date), RateLimit-Reset (seconds) or X-RateLimit-Reset (epoch seconds). */
  retryAt(response: ProviderHttpResponse, fallbackSeconds = 60): string {
    const now = this.options.now().getTime();
    const header = response.headers['retry-after'];
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) return new Date(now + seconds * 1000).toISOString();
      const date = Date.parse(header);
      if (Number.isFinite(date)) return new Date(Math.max(date, now)).toISOString();
    }
    const reset = Number(response.headers['ratelimit-reset']);
    if (Number.isFinite(reset) && reset > 0 && reset < 86_400 * 7) return new Date(now + reset * 1000).toISOString();
    const epoch = Number(response.headers['x-ratelimit-reset']);
    if (Number.isFinite(epoch) && epoch * 1000 > now) return new Date(epoch * 1000).toISOString();
    return new Date(now + fallbackSeconds * 1000).toISOString();
  }

  /**
   * Common HTTP status handling. Providers with envelope errors (HTTP 200 or 400 with an error body)
   * inspect the body before calling this.
   */
  assertOk(response: ProviderHttpResponse, provider: string, detail?: string | null): void {
    const { status } = response;
    if (status >= 200 && status < 300) return;
    const suffix = detail ? `: ${this.scrub(detail).slice(0, 300)}` : '';
    if (status === 401 || status === 403) {
      throw new ProviderError('auth', `${provider} rejected the credentials (HTTP ${status})${suffix}`, { status });
    }
    if (status === 429) {
      throw new ProviderError('rate_limited', `${provider} rate limit reached (HTTP 429)${suffix}`, {
        status,
        retryAt: this.retryAt(response),
      });
    }
    if (status >= 500) throw new ProviderError('transient', `${provider} server error (HTTP ${status})${suffix}`, { status });
    throw new ProviderError('rejected', `${provider} rejected the request (HTTP ${status})${suffix}`, { status });
  }
}

export function parseJson<T = unknown>(response: ProviderHttpResponse, provider: string): T {
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new ProviderError('bad_response', `${provider} returned a response that is not valid JSON (HTTP ${response.status})`, {
      status: response.status,
    });
  }
}

/** Parses JSON when possible, for error bodies that may be empty or HTML. */
export function tryJson(response: ProviderHttpResponse): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
}

/** Interprets yes/no/true/false strings and booleans; null when absent or unrecognized. */
export function yesNo(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'yes' || v === 'true' || v === '1') return true;
  if (v === 'no' || v === 'false' || v === '0') return false;
  return null;
}
