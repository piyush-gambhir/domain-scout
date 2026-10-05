'use client';

import { useSyncExternalStore } from 'react';
import { writeStorage } from '@/lib/storage';
import { SIDEBAR_STORAGE_KEY } from './sidebar-script';

/*
 * Collapsed (icon rail) state. The inline script in the root layout copies the saved value onto
 * <html data-sidebar> before first paint; this store keeps that attribute and localStorage in sync.
 */
const listeners = new Set<() => void>();

function read(): boolean {
  return document.documentElement.dataset.sidebar === 'collapsed';
}

export function setSidebarCollapsed(collapsed: boolean) {
  document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
  writeStorage('local', SIDEBAR_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
  for (const listener of listeners) listener();
}

export function toggleSidebar() {
  setSidebarCollapsed(!read());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
