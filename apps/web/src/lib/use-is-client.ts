'use client';

import { useSyncExternalStore } from 'react';

const noop = () => () => {};


export function useIsClient(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}
