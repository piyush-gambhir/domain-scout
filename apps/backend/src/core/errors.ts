import {
  ArgumentsHost,
  Catch,
  HttpException,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, type ApiError, type ErrorCode } from '@domain-scout/contracts';
import { ZodError } from 'zod';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  credential_required: 409,
  unsupported: 400,
  unavailable: 503,
  internal: 500,
};

export interface AppErrorExtras {
  domain?: string | null;
  source?: string | null;
  retryable?: boolean;
  retryAt?: string | null;
  details?: { path: string; message: string }[] | null;
  status?: number;
}

/** Error with a stable contract code. Throw it from services; the filter maps it to ErrorResponse. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extras: AppErrorExtras = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.status = extras.status ?? STATUS_BY_CODE[code];
  }

  static notFound(what: string) {
    return new AppError('not_found', `${what} not found`);
  }
  static invalid(message: string, details?: { path: string; message: string }[]) {
    return new AppError('invalid_request', message, { details: details ?? null });
  }
  static conflict(message: string) {
    return new AppError('conflict', message);
  }
}

export function zodDetails(error: ZodError) {
  return error.issues.map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message }));
}

export function toApiError(error: unknown, requestId: string): { status: number; body: ApiError } {
  const base = { requestId, domain: null, source: null, retryable: false, retryAt: null, details: null };
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        ...base,
        code: error.code,
        message: error.message,
        domain: error.extras.domain ?? null,
        source: error.extras.source ?? null,
        retryable: error.extras.retryable ?? false,
        retryAt: error.extras.retryAt ?? null,
        details: error.extras.details ?? null,
      },
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: { ...base, code: 'invalid_request', message: 'Request validation failed', details: zodDetails(error) },
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code: ErrorCode =
      status === 404 ? 'not_found' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status < 500 ? 'invalid_request' : 'internal';
    // Body-parser errors (e.g. payload too large) arrive here with a 4xx status.
    return { status, body: { ...base, code, message: error.message } };
  }
  const maybeStatus = (error as { status?: unknown })?.status;
  if (typeof maybeStatus === 'number' && maybeStatus >= 400 && maybeStatus < 500) {
    return { status: maybeStatus, body: { ...base, code: 'invalid_request', message: (error as Error).message } };
  }
  return { status: 500, body: { ...base, code: 'internal', message: 'Internal error', retryable: true } };
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { requestId?: string }>();
    const requestId = request.requestId ?? randomUUID();
    const { status, body } = toApiError(exception, requestId);
    if (status >= 500) this.logger.error(`${request.method} ${request.path} failed`, (exception as Error)?.stack);
    if (response.headersSent) {
      response.end();
      return;
    }
    response.status(status).json({ contractVersion: CONTRACT_VERSION, error: body });
  }
}
