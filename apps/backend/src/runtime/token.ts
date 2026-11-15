import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { restrictToOwner, writeOwnerOnlyFile } from './files.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;


export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}





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


export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}


export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
