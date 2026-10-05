import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { routes, type OperationId, type RouteDef } from '@domain-scout/contracts';
import { APP_CONFIG, type AppConfig } from '../core/config.js';
import { AppError } from '../core/errors.js';
import { ROUTE_OPERATION } from '../core/route.js';
import { AuthService, CSRF_HEADER, SESSION_COOKIE, type RequestAuth } from './auth.service.js';
import { normalizeOrigin } from './cli.js';
import { ShutdownCoordinator } from './shutdown.js';
import { safeEqual } from './token.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Operations still served while the backend is stopping. */
const DURING_STOP = new Set<OperationId>(['getHealth', 'stopService']);

/**
 * Global guard. Operations marked `auth: 'none'` in the contract route table are public; everything
 * else (including handlers not bound with @ApiRoute) needs the API token or a browser session.
 * Sessions must send X-CSRF-Token on mutating methods. A present Origin must be an allowed web origin
 * on every route, public ones included.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly origins: Set<string>;

  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly shutdown: ShutdownCoordinator,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.origins = new Set(config.webOrigins.map((o) => normalizeOrigin(o)).filter((o): o is string => o !== null));
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const operationId = this.reflector.get<OperationId | undefined>(ROUTE_OPERATION, context.getHandler());
    const def = operationId ? (routes[operationId] as RouteDef) : undefined;
    // Origin applies to public routes too: no other site may drive the session exchange.
    const origin = req.headers.origin;
    if (origin !== undefined && !this.origins.has(origin)) {
      throw new AppError('forbidden', 'Origin is not an allowed web origin');
    }
    req.auth = def?.auth === 'none' ? { kind: 'none' } : this.authenticate(req);
    if (this.shutdown.isStopping && !(operationId && DURING_STOP.has(operationId))) {
      throw new AppError('unavailable', 'The backend is stopping', { retryable: true });
    }
    return true;
  }

  private authenticate(req: Request): RequestAuth {
    const authorization = req.headers.authorization;
    if (authorization !== undefined) {
      const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
      if (!match || !this.auth.verifyApiToken(match[1]!)) throw new AppError('unauthorized', 'Invalid API token');
      return { kind: 'token' };
    }
    const sessionId = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (sessionId) {
      const session = this.auth.findSession(sessionId);
      if (!session) throw new AppError('unauthorized', 'Browser session is unknown or expired');
      if (MUTATING_METHODS.has(req.method)) {
        const csrf = req.headers[CSRF_HEADER];
        if (typeof csrf !== 'string' || !safeEqual(csrf, session.csrfToken)) {
          throw new AppError('forbidden', 'Missing or invalid CSRF token');
        }
      }
      return { kind: 'session', ...session };
    }
    throw new AppError('unauthorized', 'Authentication required: send the API token or a browser session');
  }
}

/** Value of one cookie from a Cookie header, or null. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim().replace(/^"(.*)"$/, '$1');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}
