'use client';

import { useCallback, useRef } from 'react';
import { newIdempotencyKey } from './api';

/**
 * Idempotency keys per user-initiated submission. Retrying the same body (for example after a lost
 * response) reuses the key so the backend returns the original job instead of starting another.
 * A changed body gets a new key. Call reset() after success so a later deliberate re-run is new.
 */
export function useIdempotency() {
  const current = useRef<{ signature: string; key: string } | null>(null);
  const keyFor = useCallback((body: unknown) => {
    const signature = JSON.stringify(body);
    if (current.current?.signature !== signature) current.current = { signature, key: newIdempotencyKey() };
    return current.current.key;
  }, []);
  const reset = useCallback(() => {
    current.current = null;
  }, []);
  return { keyFor, reset };
}
