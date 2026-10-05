'use client';

import { useQuery } from '@tanstack/react-query';
import type { ResultFilter } from '@domain-scout/contracts';
import { api } from './api';

/** Query keys. Caches hold unwrapped `data` so SSE updates can write them directly. */
export const qk = {
  session: ['session'] as const,
  jobs: (query?: object) => (query ? (['jobs', query] as const) : (['jobs'] as const)),
  job: (id: string) => ['job', id] as const,
  jobResults: (id: string, filter?: ResultFilter) =>
    filter ? (['jobResults', id, filter] as const) : (['jobResults', id] as const),
  evidence: (name: string) => ['evidence', name] as const,
  collections: ['collections'] as const,
  collection: (id: string) => ['collection', id] as const,
  collectionEntries: (id: string) => ['collectionEntries', id] as const,
  providers: ['providers'] as const,
  presets: ['presets'] as const,
  criteria: ['criteria'] as const,
  notices: ['notices'] as const,
  nameCheckServices: ['nameCheckServices'] as const,
};

export function useProviders() {
  return useQuery({
    queryKey: qk.providers,
    queryFn: ({ signal }) => api.call('listProviders', { signal }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function usePresets() {
  return useQuery({
    queryKey: qk.presets,
    queryFn: ({ signal }) => api.call('listPresets', { signal }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useCollections(enabled = true) {
  return useQuery({
    queryKey: qk.collections,
    queryFn: ({ signal }) => api.call('listCollections', { query: { limit: 1000 }, signal }).then((r) => r.data),
    enabled,
  });
}

export function useCriteria() {
  return useQuery({
    queryKey: qk.criteria,
    queryFn: ({ signal }) => api.call('listCriteria', { signal }).then((r) => r.data),
  });
}

export function useNameCheckServices() {
  return useQuery({
    queryKey: qk.nameCheckServices,
    queryFn: ({ signal }) => api.call('listNameCheckServices', { signal }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

/** Unread change notices for the sidebar badge. Silent when monitoring is unavailable. */
export function useUnreadNoticeCount(): number {
  const { data } = useQuery({
    queryKey: [...qk.notices, 'unread-count'],
    queryFn: ({ signal }) =>
      api.call('listNotices', { query: { unread: 'true', limit: 100 }, signal }).then((r) => r.total ?? r.data.length),
    refetchInterval: 60_000,
    retry: false,
  });
  return data ?? 0;
}
