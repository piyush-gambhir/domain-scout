'use client';

import { useSyncExternalStore } from 'react';

const noop = () => () => {};

/** False during server rendering and hydration, true afterwards. Gates UI that reads browser storage. */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}
