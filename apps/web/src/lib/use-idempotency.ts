'use client';

import { useCallback, useRef } from 'react';
import { newIdempotencyKey } from './api';






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
