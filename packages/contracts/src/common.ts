import { z } from 'zod';

/** Version of the public API contract. Every response carries it so agents can detect drift. */
export const CONTRACT_VERSION = '1.0.0';
/** Version of the local runtime handshake (runtime file, auth exchange). */
export const PROTOCOL_VERSION = 1;

export const Uuid = z.uuid().meta({ id: 'Uuid' });
/** UTC RFC 3339 timestamp, always with a `Z` offset. */
export const Timestamp = z.iso.datetime().meta({ id: 'Timestamp' });
/** Exact decimal money amount as a string, never a float. */
export const DecimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .meta({ id: 'DecimalString', description: 'Exact decimal amount as a string' });
export const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .meta({ id: 'CurrencyCode', description: 'ISO 4217 currency code' });

export const Money = z
  .object({ amount: DecimalString, currency: CurrencyCode })
  .meta({ id: 'Money' });
export type Money = z.infer<typeof Money>;

/** ASCII (A-label) domain name, lower case, no trailing dot. */
export const AsciiDomain = z
  .string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)
  .meta({ id: 'AsciiDomain' });

/** Registration suffix without the leading dot, e.g. `com` or `co.uk`. */
export const Suffix = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)*$/)
  .meta({ id: 'Suffix' });

export const ErrorCode = z
  .enum([
    'invalid_request',
    'unauthorized',
    'forbidden',
    'not_found',
    'conflict',
    'idempotency_conflict',
    'credential_required',
    'unsupported',
    'unavailable',
    'internal',
  ])
  .meta({ id: 'ErrorCode' });
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z
  .object({
    code: ErrorCode,
    message: z.string(),
    requestId: z.string(),
    domain: z.string().nullable(),
    source: z.string().nullable(),
    retryable: z.boolean(),
    retryAt: Timestamp.nullable(),
    details: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .nullable(),
  })
  .meta({ id: 'ApiError' });
export type ApiError = z.infer<typeof ApiError>;

export const ErrorResponse = z
  .object({ contractVersion: z.string(), error: ApiError })
  .meta({ id: 'ErrorResponse' });
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/** Single-resource response envelope. */
export function envelope<T extends z.ZodType>(data: T, id: string) {
  return z.object({ contractVersion: z.string(), data }).meta({ id });
}

/** Paginated list envelope with an opaque cursor. */
export function page<T extends z.ZodType>(item: T, id: string) {
  return z
    .object({
      contractVersion: z.string(),
      data: z.array(item),
      nextCursor: z.string().nullable(),
      total: z.number().int().nullable(),
    })
    .meta({ id });
}

export const PageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export const Ok = z.object({ ok: z.literal(true) }).meta({ id: 'Ok' });
export const OkResponse = envelope(Ok, 'OkResponse');

/** Freshness of an observation relative to now and the configured thresholds. */
export const Freshness = z.enum(['fresh', 'stale', 'expired']).meta({
  id: 'Freshness',
  description:
    'fresh: inside the freshness window; stale: older than the window; expired: past a provider-supplied quote expiry',
});
export type Freshness = z.infer<typeof Freshness>;

export const Reason = z
  .object({ code: z.string(), message: z.string() })
  .meta({ id: 'Reason' });
export type Reason = z.infer<typeof Reason>;
