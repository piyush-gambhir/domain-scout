'use client';

import { useSyncExternalStore } from 'react';
import { writeStorage } from '@/lib/storage';
import { SIDEBAR_STORAGE_KEY } from './sidebar-script';





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
