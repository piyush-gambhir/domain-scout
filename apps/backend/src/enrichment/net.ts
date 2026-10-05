/** Small network helpers shared by the enrichment handlers. */

export interface BoundedBody {
  text: string;
  bytes: number;
  truncated: boolean;
}

/** Reads at most `maxBytes` of a response body, then cancels the rest. */
export async function readBounded(response: Response, maxBytes: number): Promise<BoundedBody> {
  if (!response.body) return { text: '', bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - bytes));
        bytes = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated };
}

/** Releases an unread body so the connection is not held open. */
export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Combines the job's abort signal with a per-request timeout. */
export function withTimeout(signal: AbortSignal, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal: AbortSignal.any([signal, timeout]),
    /** True when the timeout fired (not a job cancellation). */
    timedOut: () => timeout.aborted && !signal.aborted,
  };
}

/** Rethrows when the job itself was cancelled: a cancelled request is not evidence. */
export function throwIfJobAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
}

export type NetworkFailure = 'timeout' | 'unreachable' | 'tls' | 'error';

const UNREACHABLE_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EAI_NONAME']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ETIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/** Classifies fetch, node:tls and node:dns errors into stable failure kinds and codes. */
export function classifyError(error: unknown, timedOut = false): { kind: NetworkFailure; code: string; message: string } {
  const err = error as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  const code = err?.cause?.code ?? err?.code ?? err?.name ?? 'unknown';
  const message = err?.cause?.message ?? err?.message ?? String(error);
  if (timedOut || err?.name === 'TimeoutError' || TIMEOUT_CODES.has(code)) return { kind: 'timeout', code: 'timeout', message: 'Request timed out' };
  if (UNREACHABLE_CODES.has(code)) return { kind: 'unreachable', code: code.toLowerCase(), message };
  if (/CERT|SSL|TLS/i.test(code)) return { kind: 'tls', code: code.toLowerCase(), message };
  return { kind: 'error', code: 'network_error', message };
}

/** Retry-After as seconds or an HTTP date, relative to `now`. */
export function retryAfter(header: string | null, now: Date): string | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return new Date(now.getTime() + seconds * 1000).toISOString();
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : new Date(date).toISOString();
}
