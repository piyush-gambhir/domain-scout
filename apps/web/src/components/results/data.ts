'use client';

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { TERMINAL_JOB_STATES, type ConfirmationStatus, type Job, type JobItem, type ResultFilter } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { PROBLEM_OUTCOMES, type RegistryGroup } from '@/lib/labels';
import { qk } from '@/lib/queries';
import { useIdempotency } from '@/lib/use-idempotency';
import { filterToQuery } from '../jobs/filters';


export const GRID_MAX_ITEMS = 2000;

export const GRID_MAX_LABELS = 30;
const ALL_PAGE = 1000;
export const SECTION_PAGE = 200;


export function labelOf(item: Pick<JobItem, 'subject' | 'suffix' | 'unicode'>): string {
  if (!item.suffix) return item.subject;
  return item.subject.endsWith(`.${item.suffix}`) ? item.subject.slice(0, -item.suffix.length - 1) : item.subject;
}


export function unicodeLabelOf(item: Pick<JobItem, 'subject' | 'suffix' | 'unicode'>): string {
  if (!item.suffix || !item.unicode || item.unicode === item.subject) return labelOf(item);
  const parts = item.unicode.split('.');
  const suffixLabels = item.suffix.split('.').length;
  return parts.length > suffixLabels ? parts.slice(0, parts.length - suffixLabels).join('.') : labelOf(item);
}


export function useAllResults(jobId: string, enabled: boolean, poll: boolean) {
  const query = useInfiniteQuery({
    queryKey: qk.jobResults(jobId, {}),
    queryFn: ({ pageParam, signal }) => api.call('listJobResults', { params: { id: jobId }, query: { cursor: pageParam, limit: ALL_PAGE }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    refetchInterval: poll ? 3000 : false,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (enabled && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [enabled, hasNextPage, isFetchingNextPage, fetchNextPage]);
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.data) ?? [], [query.data]);
  return { ...query, items, complete: query.isSuccess && !hasNextPage };
}

export type ListSort = 'price' | 'length' | 'domain' | 'input';

export interface ListFilters {
  q?: string;
  suffixes?: string[];
  maxPrice?: string;
  maxLength?: number;

  sort?: ListSort;

  confirmations?: ConfirmationStatus[];

  saved?: boolean;

  currency?: string;

  outcomes?: string[];

  collectionId?: string;

  resolved?: boolean;
  order?: 'asc' | 'desc';
}

const GROUP_OUTCOMES: Record<Exclude<RegistryGroup, 'pending'>, readonly string[]> = {
  free: ['no_record'],
  taken: ['registered'],
  problem: PROBLEM_OUTCOMES,
};


export function groupAllowed(group: RegistryGroup, filters: ListFilters): boolean {

  if (filters.resolved !== undefined && group === 'pending') return false;
  if (filters.resolved === true && group === 'problem') return false;
  if (filters.resolved === false && (group === 'free' || group === 'taken')) return false;
  if (filters.outcomes?.length) return group !== 'pending' && GROUP_OUTCOMES[group].some((o) => filters.outcomes!.includes(o));
  return true;
}

function narrow(group: Exclude<RegistryGroup, 'pending'>, filters: ListFilters): string[] {
  const outcomes = GROUP_OUTCOMES[group];
  return filters.outcomes?.length ? outcomes.filter((o) => filters.outcomes!.includes(o)) : [...outcomes];
}


export function sectionFilter(group: RegistryGroup, filters: ListFilters, currency: string): ResultFilter {
  const common: ResultFilter = {
    q: filters.q || undefined,
    suffixes: filters.suffixes?.length ? filters.suffixes : undefined,
    maxLength: filters.maxLength,
    confirmations: filters.confirmations?.length ? filters.confirmations : undefined,
    inCollection: filters.saved,
    collectionId: filters.collectionId,
    resolved: filters.resolved,
  };
  const order = filters.order ?? 'asc';

  const explicit: ResultFilter = filters.sort || filters.order ? { sort: filters.sort && filters.sort !== 'price' ? filters.sort : 'input', order } : {};
  switch (group) {
    case 'free':

      return { ...common, outcomes: narrow('free', filters), sort: filters.sort ?? 'price', order, priceCurrency: filters.currency ?? currency, maxPrice: filters.maxPrice };
    case 'taken':
      return { ...common, outcomes: narrow('taken', filters), ...explicit };
    case 'problem':
      return { ...common, outcomes: narrow('problem', filters), ...explicit };
    case 'pending':
      return { ...common, resolved: undefined, states: ['pending', 'running', 'interrupted'], ...explicit };
  }
}

export function useSectionResults(jobId: string, filter: ResultFilter, poll: boolean) {
  const query = useInfiniteQuery({
    queryKey: qk.jobResults(jobId, filter),
    queryFn: ({ pageParam, signal }) =>
      api.call('listJobResults', { params: { id: jobId }, query: { ...filterToQuery(filter), cursor: pageParam, limit: SECTION_PAGE }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
    refetchInterval: poll ? 5000 : false,
  });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.data) ?? [], [query.data]);
  return { ...query, items, total: query.data?.pages[0]?.total ?? null };
}


export async function resolveSection(jobId: string, filter: ResultFilter): Promise<JobItem[]> {
  const items: JobItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.call('listJobResults', { params: { id: jobId }, query: { ...filterToQuery(filter), cursor, limit: 1000 } });
    items.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}


export function groupCounts(job: Job) {
  const o = job.counters.outcomes;
  const problem = PROBLEM_OUTCOMES.reduce((sum, k) => sum + (o[k] ?? 0), 0);
  return {
    free: o.no_record ?? 0,
    taken: o.registered ?? 0,
    problem,
    pending: job.counters.pending + job.counters.running + job.counters.interrupted,
  };
}

async function allItems(jobId: string): Promise<JobItem[]> {
  const items: JobItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.call('listJobResults', { params: { id: jobId }, query: { cursor, limit: 1000 } });
    items.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}





export function useRecheckOverlay() {
  const client = useQueryClient();
  const idempotency = useIdempotency();
  const [runs, setRuns] = useState<{ id: string; domains: string[] }[]>([]);
  const start = useMutation({
    mutationFn: async (domains: string[]) => {
      const body = { domains, label: domains.length === 1 ? `Check again: ${domains[0]}` : `Check again: ${domains.length} names` };
      return { job: (await api.call('createRecheck', { body, idempotencyKey: idempotency.keyFor(body) })).data, domains };
    },
    onSuccess: ({ job, domains }) => {
      idempotency.reset();
      void client.invalidateQueries({ queryKey: qk.history() });
      setRuns((current) => [...current, { id: job.id, domains }]);
    },
  });

  const overlay = useQueries({
    queries: runs.map((run) => ({
      queryKey: ['recheckOverlay', run.id],
      queryFn: async () => {
        const job = (await api.call('getJob', { params: { id: run.id } })).data;
        if (!TERMINAL_JOB_STATES.includes(job.state)) return { done: false, items: [] as JobItem[] };
        const items = await allItems(run.id);
        for (const domain of run.domains) void client.invalidateQueries({ queryKey: qk.evidence(domain) });
        return { done: true, items };
      },
      refetchInterval: (q: { state: { data?: { done: boolean } } }) => (q.state.data?.done ? false : 1500),
      staleTime: Infinity,
    })),
    combine: (results) => {
      const overrides = new Map<string, JobItem>();
      const checking = new Set<string>();
      results.forEach((result, index) => {
        if (result.data?.done) for (const item of result.data.items) overrides.set(item.subject, item);
        else for (const domain of runs[index]?.domains ?? []) checking.add(domain);
      });
      for (const name of overrides.keys()) if (checking.has(name)) overrides.delete(name);
      return { overrides, checking };
    },
  });
  return { ...overlay, recheck: (domains: string[]) => start.mutate(domains), pending: start.isPending };
}


export function withOverride(item: JobItem, overrides: Map<string, JobItem>): JobItem {
  const next = overrides.get(item.subject);
  return next ? { ...next, id: item.id, jobId: item.jobId, collectionIds: item.collectionIds } : item;
}
