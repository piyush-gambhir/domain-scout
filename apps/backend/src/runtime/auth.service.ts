import { Inject, Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../core/config.js';
import { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { Database } from '../storage/database.js';
import { hashSecret, loadOrCreateApiToken, randomToken, safeEqual } from './token.js';

export const BOOTSTRAP_CODE_TTL_MS = 60_000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'ds_session';
export const CSRF_COOKIE = 'ds_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface SessionInfo {
  sessionId: string;
  csrfToken: string;
  expiresAt: string;
}

/** How the current request authenticated; set on `req.auth` by the AuthGuard. */
export type RequestAuth = { kind: 'token' } | ({ kind: 'session' } & SessionInfo) | { kind: 'none' };

/**
 * Local access control: the API token (CLI, launcher, Next server), single-use bootstrap codes and
 * browser sessions. Codes and session ids are stored only as SHA-256 hashes.
 */
@Injectable()
export class AuthService {
  private readonly apiToken: string;
  private readonly bootstrapTtlMs: number;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly db: Database,
    private readonly clock: Clock,
  ) {
    this.apiToken = config.apiToken ?? loadOrCreateApiToken(join(config.runtimeDir, 'api-token'));
    this.bootstrapTtlMs = config.bootstrapTtlMs ?? BOOTSTRAP_CODE_TTL_MS;
  }

  verifyApiToken(candidate: string): boolean {
    return safeEqual(candidate, this.apiToken);
  }

  createBootstrapCode(): { code: string; expiresAt: string } {
    const code = randomToken();
    const now = this.clock.iso();
    const expiresAt = this.clock.plus(this.bootstrapTtlMs);
    this.db.transaction(() => {
      this.db.run('DELETE FROM bootstrap_codes WHERE expires_at <= ? OR used_at IS NOT NULL', [now]);
      this.db.run('INSERT INTO bootstrap_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)', [
        hashSecret(code),
        now,
        expiresAt,
      ]);
    });
    return { code, expiresAt };
  }

  /** Consumes a bootstrap code (single use, unexpired) and opens a 7-day session. */
  exchangeBootstrapCode(code: string): SessionInfo {
    const now = this.clock.iso();
    return this.db.transaction(() => {
      const { changes } = this.db.run(
        'UPDATE bootstrap_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?',
        [now, hashSecret(code), now],
      );
      if (changes !== 1) throw new AppError('unauthorized', 'Bootstrap code is invalid, expired or already used');
      const session: SessionInfo = {
        sessionId: randomToken(),
        csrfToken: randomToken(),
        expiresAt: this.clock.plus(SESSION_TTL_MS),
      };
      this.db.run('DELETE FROM sessions WHERE expires_at <= ?', [now]);
      this.db.run('INSERT INTO sessions (id_hash, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?)', [
        hashSecret(session.sessionId),
        session.csrfToken,
        now,
        session.expiresAt,
      ]);
      return session;
    });
  }

  /** The live session for a cookie value, or null when unknown or expired. */
  findSession(sessionId: string): SessionInfo | null {
    if (!sessionId) return null;
    const row = this.db.get<{ csrf_token: string; expires_at: string }>(
      'SELECT csrf_token, expires_at FROM sessions WHERE id_hash = ?',
      [hashSecret(sessionId)],
    );
    if (!row || Date.parse(row.expires_at) <= this.clock.now().getTime()) return null;
    return { sessionId, csrfToken: row.csrf_token, expiresAt: row.expires_at };
  }
}
