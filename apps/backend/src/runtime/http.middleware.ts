import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { CONTRACT_VERSION, type ErrorCode } from '@domain-scout/contracts';
import type { AppConfig } from '../core/config.js';
import type { RequestAuth } from './auth.service.js';
import { isLoopbackHost } from './cli.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Echoed X-Request-Id or a generated UUID; appears in every ErrorResponse. */
      requestId?: string;
      /** Set by the AuthGuard. */
      auth?: RequestAuth;
    }
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Sends an ErrorResponse from Express middleware, where the Nest exception filter does not run. */
export function sendError(req: Request, res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({
    contractVersion: CONTRACT_VERSION,
    error: {
      code,
      message,
      requestId: req.requestId ?? randomUUID(),
      domain: null,
      source: null,
      retryable: false,
      retryAt: null,
      details: null,
    },
  });
}

/**
 * First middleware on every request: assigns the request id, then rejects any Host header other
 * than the loopback names on the port this connection arrived on (DNS rebinding protection).
 */
export function requestContextMiddleware(config: Pick<AppConfig, 'host'>) {
  // Another loopback bind address (e.g. 127.0.0.2) is also accepted; never a non-loopback name.
  const extra = isLoopbackHost(config.host) ? bracket(config.host.toLowerCase()) : null;
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    req.requestId = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    if (!hostAllowed(req.headers.host, req.socket.localPort, extra)) {
      sendError(req, res, 403, 'forbidden', 'Host header is not an allowed loopback address');
      return;
    }
    next();
  };
}

export function hostAllowed(hostHeader: string | undefined, localPort: number | undefined, extraHost: string | null): boolean {
  if (!hostHeader || !localPort) return false;
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d+))?$/i.exec(hostHeader.trim());
  if (!match) return false;
  const name = match[1]!.toLowerCase();
  const port = match[2] === undefined ? 80 : Number(match[2]);
  if (port !== localPort) return false;
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === extraHost;
}

function bracket(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
