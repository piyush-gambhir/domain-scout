'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Collection, JobItem, OperationResponse, Watch } from '@domain-scout/contracts';
import { api } from './api';
import { plural } from './format';
import { qk, useCollections } from './queries';


export const DEFAULT_LIST_NAME = 'Saved';

export function defaultListOf(collections: Collection[] | undefined): Collection | null {
  return collections?.find((c) => c.name === DEFAULT_LIST_NAME) ?? null;
}

type ResultsPage = OperationResponse<'listJobResults'>;


function patchSavedMarks(client: ReturnType<typeof useQueryClient>, domains: Set<string>, listId: string, saved: boolean) {
  client.setQueriesData<InfiniteData<ResultsPage>>({ queryKey: ['jobResults'] }, (data) => {
    if (!data?.pages) return data;
    let changed = false;
    const pages = data.pages.map((page) => {
      let next: JobItem[] | null = null;
      page.data.forEach((item, index) => {
        if (!domains.has(item.subject)) return;
        const has = item.collectionIds.includes(listId);
        if (has === saved) return;
        next ??= page.data.slice();
        next[index] = { ...item, collectionIds: saved ? [...item.collectionIds, listId] : item.collectionIds.filter((id) => id !== listId) };
      });
      if (!next) return page;
      changed = true;
      return { ...page, data: next };
    });
    return changed ? { ...data, pages } : data;
  });
}


let creatingDefault: Promise<Collection> | null = null;

async function ensureDefaultList(): Promise<Collection> {
  creatingDefault ??= (async () => {

    const fresh = (await api.call('listCollections', { query: { limit: 1000 } })).data;
    return defaultListOf(fresh) ?? (await api.call('createCollection', { body: { name: DEFAULT_LIST_NAME } })).data;
  })().finally(() => {
    creatingDefault = null;
  });
  return creatingDefault;
}


function byMembership(query: { queryKey: readonly unknown[] }): boolean {
  const filter = query.queryKey[2] as { inCollection?: boolean; collectionId?: string } | undefined;
  return Boolean(filter && (filter.inCollection !== undefined || filter.collectionId !== undefined));
}





export function useQuickSave() {
  const client = useQueryClient();
  const router = useRouter();
  const collections = useCollections();
  return useMutation({
    mutationFn: async ({ domains, save }: { domains: string[]; save: boolean }) => {
      let list = defaultListOf(collections.data) ?? defaultListOf(client.getQueryData<Collection[]>(qk.collections));
      if (!list && !save) return { list: null, domains, save };
      list ??= await ensureDefaultList();
      if (save) await api.call('addCollectionEntries', { params: { id: list.id }, body: { domains } });
      else await api.call('removeCollectionEntries', { params: { id: list.id }, body: { domains } });
      return { list, domains, save };
    },
    onSuccess: ({ list, domains, save }) => {
      if (!list) return;
      patchSavedMarks(client, new Set(domains), list.id, save);
      void client.invalidateQueries({ queryKey: ['jobResults'], predicate: byMembership });
      void client.invalidateQueries({ queryKey: qk.collections });
      void client.invalidateQueries({ queryKey: qk.collection(list.id) });
      void client.invalidateQueries({ queryKey: qk.collectionEntries(list.id) });
      for (const domain of domains) void client.invalidateQueries({ queryKey: qk.evidence(domain) });
      const what = domains.length === 1 ? domains[0]! : plural(domains.length, 'name');
      if (save) toast.success(`Saved ${what}`, { action: { label: 'Open', onClick: () => router.push(`/saved/${list.id}`) } });
      else toast(`Removed ${what} from ${list.name}`);
    },
  });
}

export type WatchIndex = Map<string, Watch>;


export function useWatchIndex() {
  const query = useQuery({
    queryKey: qk.watchIndex,
    queryFn: ({ signal }) => api.call('listWatches', { query: { limit: 1000 }, signal }).then((r) => r.data),
    staleTime: 30_000,
    retry: false,
  });
  const index = useMemo<WatchIndex>(() => {
    const map = new Map<string, Watch>();
    for (const watch of query.data ?? []) for (const domain of watch.domains) if (!map.has(domain)) map.set(domain, watch);
    return map;
  }, [query.data]);
  return { ...query, index };
}


export function useQuickWatch() {
  const client = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: async (domain: string) => (await api.call('createWatch', { body: { name: domain, domains: [domain] } })).data,
    onSuccess: (watch) => {
      client.setQueryData(qk.watch(watch.id), watch);
      void client.invalidateQueries({ queryKey: qk.watches });
      toast.success(`Watching ${watch.name}`, { action: { label: 'Edit', onClick: () => router.push(`/watching/${watch.id}?edit=1`) } });
    },
  });
}
