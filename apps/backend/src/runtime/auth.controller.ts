import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../core/errors.js';
import { ok } from '../core/envelope.js';
import { ApiInput, ApiRoute, type RouteInput } from '../core/route.js';
import { AuthService } from './auth.service.js';

/** Browser session bootstrap. The Next server sets the cookies; the backend only issues and validates. */
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @ApiRoute('createBootstrapCode')
  createBootstrapCode(@Req() req: Request) {
    // A browser session must not mint codes for further sessions.
    if (req.auth?.kind !== 'token') throw new AppError('forbidden', 'Bootstrap codes require the API token');
    return ok(this.auth.createBootstrapCode());
  }

  @ApiRoute('createSession')
  createSession(@ApiInput() input: RouteInput<'createSession'>) {
    return ok(this.auth.exchangeBootstrapCode(input.body.code));
  }

  @ApiRoute('getSession')
  getSession(@Req() req: Request) {
    const auth = req.auth;
    if (auth?.kind !== 'session') throw new AppError('forbidden', 'Only browser sessions have session info');
    return ok({ sessionId: auth.sessionId, csrfToken: auth.csrfToken, expiresAt: auth.expiresAt });
  }
}
