'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OperationArgs, ResultFilter } from '@domain-scout/contracts';
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
  noticeList: (query: object) => ['notices', 'list', query] as const,
  nameCheckServices: ['nameCheckServices'] as const,
  settings: ['settings'] as const,
  watches: ['watches'] as const,
  watchIndex: ['watches', 'index'] as const,
  watch: (id: string) => ['watches', id] as const,
  watchRuns: (id: string) => ['watches', id, 'runs'] as const,
  history: (query?: object) => (query ? (['history', query] as const) : (['history'] as const)),
  jobSummaries: (query: object) => ['jobs', 'summaries', query] as const,
  priceHistory: (query: object) => ['priceHistory', query] as const,
  generationThemes: ['generationThemes'] as const,
  comparison: (request: object) => ['comparison', request] as const,
  transferOptions: (domain: string) => ['transferOptions', domain] as const,
  listings: (domain: string) => ['listings', domain] as const,
  aftermarketSources: ['aftermarketSources'] as const,
  portfolio: ['portfolio'] as const,
  coverage: ['coverage'] as const,
  dataInventory: ['dataInventory'] as const,
  artifacts: ['artifacts'] as const,
  capabilities: ['capabilities'] as const,
  health: ['health'] as const,
};

export function useSettings() {
  return useQuery({
    queryKey: qk.settings,
    queryFn: ({ signal }) => api.call('getSettings', { signal }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export type SettingsPatchInput = OperationArgs<'patchSettings'>['body'];

/** Saves part of the settings; the response replaces the cached settings. */
export function usePatchSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (patch: SettingsPatchInput) => (await api.call('patchSettings', { body: patch })).data,
    onSuccess: (settings) => client.setQueryData(qk.settings, settings),
  });
}

export function useProviders() {
  return useQuery({
    queryKey: qk.providers,
    queryFn: ({ signal }) => api.call('listProviders', { query: { limit: 1000 }, signal }).then((r) => r.data),
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
