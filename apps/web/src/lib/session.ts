'use client';

import { useSyncExternalStore } from 'react';


let required = false;
const listeners = new Set<() => void>();

export function markSessionRequired() {
  if (required) return;
  required = true;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSessionRequired(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => required,
    () => false,
  );
}
