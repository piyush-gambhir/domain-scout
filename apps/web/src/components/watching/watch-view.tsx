'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { TERMINAL_JOB_STATES, type JobItem, type Notice } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { useWatchEvents, watchesDeletedHere } from '@/lib/events';
import { NOTICE_TYPE, WATCH_STATE, humanize, registryStatus, watchRunStatus } from '@/lib/labels';
import { formatCount, formatDate, formatDateTime, formatInterval, plural } from '@/lib/format';
import { qk, useProviders } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { RelativeTime } from '../domain/time';
import { NoticeFeed } from './notices';
import { WatchActions } from './watch-actions';
import { WatchFormDialog } from './watch-form';
import { Crumb, EmptyState, ErrorState, Facts, Page, PageHeader } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { Skeleton, SkeletonRows } from '../ui/skeleton';
import { MissedRuns, NextRun } from './watching-page';

/** Current registry state of each watched name, from the watch's latest run. */
function Names({ domains, lastJobId, notices }: { domains: string[]; lastJobId: string | null; notices: Notice[] }) {
  // The latest run may still be going: follow it until it finishes, then read every page of results.
  const run = useQuery({
    queryKey: qk.job(lastJobId ?? 'none'),
    queryFn: ({ signal }) => api.call('getJob', { params: { id: lastJobId! }, signal }).then((r) => r.data),
    enabled: Boolean(lastJobId),
    refetchInterval: (q) => (q.state.data && !TERMINAL_JOB_STATES.includes(q.state.data.state) ? 3000 : false),
  });
  const results = useQuery({
    queryKey: ['watchNames', lastJobId, run.data?.state ?? null, run.data?.counters.finished ?? 0],
    queryFn: async ({ signal }) => {
      const items: JobItem[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.call('listJobResults', { params: { id: lastJobId! }, query: { cursor, limit: 1000 }, signal });
        items.push(...page.data);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return items;
    },
    enabled: Boolean(lastJobId),
    placeholderData: (previous) => previous,
  });
  const byDomain = useMemo(() => {
    const map = new Map<string, JobItem>();
    for (const item of results.data ?? []) if (item.operation === 'registry') map.set(item.subject, item);
    return map;
  }, [results.data]);
  const lastChange = useMemo(() => {
    const map = new Map<string, Notice>();
    for (const n of notices) {
      const current = map.get(n.domain);
      if (!current || current.createdAt < n.createdAt) map.set(n.domain, n);
    }
    return map;
  }, [notices]);
  return (
    <section aria-label="Names" className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1">
      <h2 className="mb-1 px-1 text-sm font-semibold">
        Names <span className="font-normal text-muted-foreground tabular">{formatCount(domains.length)}</span>
      </h2>
      <div className="relative -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        <ul className="flex flex-col" aria-label="Watched names">
          {domains.map((domain) => {
            const item = byDomain.get(domain);
            const change = lastChange.get(domain);
            const expires = item?.evidence.registry?.registration?.expiresAt;
            return (
              <li key={domain} className="grid min-h-9 grid-cols-[minmax(0,1fr)_8rem] items-center gap-x-3 rounded-md px-1 py-1 text-sm hover:bg-hover" data-testid="watched-name">
                <span className="min-w-0">
                  <Link href={`/domains/${encodeURIComponent(domain)}`} className="block truncate rounded-sm font-mono underline-offset-4 hover:underline">
                    {domain}
                  </Link>
                  <span className="block truncate text-xs text-muted-foreground">
                    {change ? `${NOTICE_TYPE[change.type] ?? humanize(change.type)} ${formatDate(change.createdAt)}` : expires ? `Expires ${formatDate(expires)}` : null}
                  </span>
                </span>
                {results.isPending && lastJobId ? (
                  <Skeleton className="h-4 w-20" />
                ) : item?.outcome ? (
                  <StatusLabel status={registryStatus(item.outcome)} />
                ) : (
                  <span className="text-xs text-muted-foreground">Not checked yet</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function Runs({ watchId }: { watchId: string }) {
  const runs = useInfiniteQuery({
    queryKey: qk.watchRuns(watchId),
    queryFn: ({ pageParam, signal }) => api.call('listWatchRuns', { params: { id: watchId }, query: { cursor: pageParam, limit: 50 }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const rows = runs.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <section aria-label="Runs" className="flex min-w-0 flex-col lg:max-h-[42%] lg:min-h-0 lg:shrink-0">
      <h2 className="mb-1 px-2.5 text-sm font-semibold">Checks</h2>
      {runs.isPending ? (
        <SkeletonRows rows={4} />
      ) : runs.isError ? (
        <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState>No checks yet.</EmptyState>
      ) : (
        <div className="relative -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          <ul className="flex flex-col">
            {rows.map((run) => (
              <li key={run.id} className="grid min-h-9 grid-cols-[minmax(0,1fr)_7rem_auto] items-center gap-x-4 rounded-md px-2.5 py-1 text-sm hover:bg-hover" data-testid="watch-run">
                <span className="min-w-0">
                  <StatusLabel status={watchRunStatus(run.status)} />
                  {run.note ? <span className="block truncate text-xs text-muted-foreground">{run.note}</span> : null}
                </span>
                <span className="text-xs text-muted-foreground" title={formatDateTime(run.startedAt ?? run.scheduledFor)}>
                  {run.startedAt ? <RelativeTime iso={run.startedAt} /> : 'Did not run'}
                  {run.startedAt ? (
                    <span className="block">
                      {plural(run.changes, 'change')}
                      {run.failures ? `, ${plural(run.failures, 'failure')}` : ''}
                    </span>
                  ) : null}
                </span>
                <span className="text-right text-xs">
                  {run.jobId ? (
                    <Link href={`/search/${run.jobId}`} className="rounded-sm underline-offset-4 hover:underline">
                      Results
                    </Link>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {runs.hasNextPage ? (
            <div className="flex justify-center py-2">
              <Button variant="ghost" disabled={runs.isFetchingNextPage} onClick={() => runs.fetchNextPage()}>
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function WatchingCrumb() {
  return (
    <Crumb>
      <Link href="/watching" className="rounded-sm hover:text-foreground">
        Watching
      </Link>
    </Crumb>
  );
}

export function WatchView({ watchId }: { watchId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const providers = useProviders();
  const [editing, setEditing] = useState(searchParams.get('edit') === '1');
  const watch = useQuery({
    queryKey: qk.watch(watchId),
    queryFn: ({ signal }) => api.call('getWatch', { params: { id: watchId }, signal }).then((r) => r.data),
    refetchInterval: 30_000,
  });
  const notices = useQuery({
    queryKey: qk.noticeList({ watchId, names: true }),
    queryFn: ({ signal }) => api.call('listNotices', { query: { watchId, limit: 200 }, signal }).then((r) => r.data),
  });
  const names = new Map((providers.data ?? []).map((p) => [p.id, p.name]));
  useWatchEvents((deletedId) => {
    if (deletedId !== watchId) return;
    if (!watchesDeletedHere.has(deletedId)) toast('This watch was deleted');
    router.replace('/watching');
  });

  if (watch.isPending) {
    return (
      <Page>
        <Skeleton className="h-control w-72" />
        <SkeletonRows rows={8} />
      </Page>
    );
  }
  if (watch.isError) {
    return (
      <Page>
        <PageHeader title="Watch" leading={<WatchingCrumb />} />
        <ErrorState error={watch.error} onRetry={() => watch.refetch()} />
      </Page>
    );
  }
  const data = watch.data;
  return (
    <Page>
      <PageHeader
        leading={<WatchingCrumb />}
        title={data.name}
        meta={
          <>
            <StatusLabel status={WATCH_STATE[data.state] ?? { label: data.state, tone: 'muted' }} className="font-medium" />
            <span className="text-muted-foreground">
              {formatInterval(data.intervalMinutes)} · <NextRun watch={data} />
            </span>
          </>
        }
        actions={<WatchActions watch={data} onDeleted={() => router.push('/watching')} />}
      />
      <div className="flex flex-col gap-8 lg:min-h-0 lg:flex-1 lg:flex-row lg:gap-10">
        <div className="flex min-w-0 flex-col gap-5 lg:min-h-0 lg:w-[24rem] lg:shrink-0">
          <Facts
            className="shrink-0"
            items={[
              ['Last check', data.lastRunAt ? <RelativeTime key="l" iso={data.lastRunAt} /> : <span className="text-muted-foreground">Never</span>],
              ['Missed', <MissedRuns key="m" count={data.missedRuns} />],
              ['Registry', data.includeRegistry ? 'Checked' : 'Not checked'],
              ['Providers', data.providerIds.length ? data.providerIds.map((id) => names.get(id) ?? id).join(', ') : 'None'],
              ['Published prices', data.includeCatalogPrices ? 'Tracked' : 'Not tracked'],
              ['Sends names to', data.destinations.length ? <span key="d" className={cn('break-all font-mono text-xs')}>{data.destinations.join(', ')}</span> : 'Nobody'],
            ]}
          />
          <Names domains={data.domains} lastJobId={data.lastJobId} notices={notices.data ?? []} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-8 lg:min-h-0">
          <Runs watchId={watchId} />
          <NoticeFeed title="Changes" watchId={watchId} unreadCount={data.unreadNotices} className="lg:min-h-0 lg:flex-1" />
        </div>
      </div>
      <WatchFormDialog open={editing} onOpenChange={setEditing} watch={data} />
    </Page>
  );
}
