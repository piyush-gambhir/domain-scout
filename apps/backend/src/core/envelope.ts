import { CONTRACT_VERSION } from '@domain-scout/contracts';


export function ok<T>(data: T) {
  return { contractVersion: CONTRACT_VERSION, data };
}


export function paged<T>(data: T[], nextCursor: string | null = null, total: number | null = null) {
  return { contractVersion: CONTRACT_VERSION, data, nextCursor, total };
}


export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T>(cursor: string | undefined | null): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}
