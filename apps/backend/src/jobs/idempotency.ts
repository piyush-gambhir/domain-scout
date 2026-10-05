import { createHash } from 'node:crypto';
import { AppError } from '../core/errors.js';

/** JSON with object keys sorted recursively and undefined members dropped, so equal requests hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortKeys(v)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** sha256 of the operation id and the canonical validated request (path parameters included when present). */
export function requestFingerprint(operationId: string, payload: unknown): string {
  return createHash('sha256').update(operationId).update('\n').update(canonicalJson(payload)).digest('hex');
}

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/** Validates an Idempotency-Key header value; absent or empty means no idempotency. */
export function idempotencyKey(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value === '') return undefined;
  if (!KEY_PATTERN.test(value)) {
    throw AppError.invalid('Idempotency-Key must be 1 to 255 printable ASCII characters without spaces');
  }
  return value;
}
