import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { restrictToOwner, writeOwnerOnlyFile } from './files.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes, base64url without padding (43 characters). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Reads the API token file, creating it (0600) when missing or malformed. The token is reused
 * across restarts so the CLI and launcher keep working; permissions are re-tightened on every load.
 */
export function loadOrCreateApiToken(tokenFile: string): string {
  try {
    const existing = readFileSync(tokenFile, 'utf8').trim();
    if (TOKEN_PATTERN.test(existing)) {
      restrictToOwner(tokenFile, false);
      return existing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = randomToken();
  writeOwnerOnlyFile(tokenFile, `${token}\n`);
  return token;
}

/** SHA-256 hex digest; secrets (session ids, bootstrap codes) are stored only in this form. */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison (hashing first equalizes lengths). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
