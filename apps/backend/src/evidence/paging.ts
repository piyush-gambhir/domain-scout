import { decodeCursor, encodeCursor } from '../core/envelope.js';


export function pageWindow(cursor: string | undefined | null, limit: number) {
  const offset = Math.max(0, decodeCursor<{ o: number }>(cursor)?.o ?? 0);
  return {
    offset,
    limit,
    next(returned: number, total: number): string | null {
      const end = offset + returned;
      return end < total ? encodeCursor({ o: end }) : null;
    },
  };
}
