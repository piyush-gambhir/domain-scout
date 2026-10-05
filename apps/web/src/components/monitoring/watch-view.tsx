'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useWatchEvents, watchesDeletedHere } from '@/lib/events';
import { WATCH_STATE, watchRunStatus } from '@/lib/labels';
import { formatCount, formatDateTime, formatInterval, plural } from '@/lib/format';
import { cn } from '@/lib/utils';
import { qk, useProviders } from '@/lib/queries';
import { RelativeTime } from '../domain/time';
import { Crumb, EmptyState, ErrorState, Facts, Page, PageHeader, ScrollPane, SectionTitle } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { Skeleton, SkeletonRows } from '../ui/skeleton';
import { MissedRuns, NextRun } from './monitoring-page';
import { NoticeFeed } from './notices';
import { WatchActions } from './watch-actions';

function Domains({ domains }: { domains: string[] }) {
  return (
    <section aria-label="Domains" className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1">
      <SectionTitle>
        Domains <span className="font-mono text-xs font-normal text-muted-foreground tabular">{formatCount(domains.length)}</span>
      </SectionTitle>
      <ScrollPane>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[13px]">
          {domains.map((domain) => (
            <li key={domain}>
              <Link href={`/domains/${encodeURIComponent(domain)}`} className="rounded-sm underline-offset-4 hover:underline">
                {domain}
              </Link>
            </li>
          ))}
        </ul>
      </ScrollPane>
    </section>
  );
}

const thClass = 'h-8 pr-3 text-left text-xs font-medium text-muted-foreground';

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
    <section aria-label="Runs" className="flex min-w-0 flex-col lg:max-h-[45%] lg:min-h-0 lg:shrink-0">
      <SectionTitle className="px-1">Runs</SectionTitle>
      {runs.isPending ? (
        <SkeletonRows rows={4} />
      ) : runs.isError ? (
        <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState>No runs yet.</EmptyState>
      ) : (
        <ScrollPane className="@container overflow-x-auto">
          <table className="w-full min-w-[30rem] table-fixed text-sm">
            <thead className="sticky top-0 z-10 bg-background">
              <tr>
                <th scope="col" className={cn(thClass, 'w-48 pl-1')}>
                  Status
                </th>
                <th scope="col" className={cn(thClass, 'hidden @xl:table-cell')}>
                  Scheduled for
                </th>
                <th scope="col" className={cn(thClass, 'w-28')}>
                  Ran
                </th>
                <th scope="col" className={cn(thClass, 'w-[4.5rem]')}>
                  Changes
                </th>
                <th scope="col" className={cn(thClass, 'w-[4.5rem]')}>
                  Failures
                </th>
                <th scope="col" className={cn(thClass, 'w-16')}>
                  <span className="sr-only">Results</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => (
                <tr key={run.id} className="align-top" data-testid="watch-run">
                  <td className="py-1.5 pl-1 pr-3">
                    <StatusLabel status={watchRunStatus(run.status)} />
                    {run.note ? <span className="block truncate text-xs text-muted-foreground">{run.note}</span> : null}
                  </td>
                  <td className="hidden truncate py-1.5 pr-3 text-muted-foreground @xl:table-cell">{formatDateTime(run.scheduledFor)}</td>
                  <td className="py-1.5 pr-3">
                    {run.startedAt ? (
                      <span title={formatDateTime(run.startedAt)}>
                        <RelativeTime iso={run.startedAt} />
                        {run.finishedAt ? null : <span className="block text-xs text-muted-foreground">not finished</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Did not run</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 font-mono tabular">{run.startedAt ? formatCount(run.changes) : <span className="font-sans text-muted-foreground">None</span>}</td>
                  <td className="py-1.5 pr-3 font-mono tabular">{run.startedAt ? formatCount(run.failures) : <span className="font-sans text-muted-foreground">None</span>}</td>
                  <td className="py-1.5 pr-1 text-right">
                    {run.jobId ? (
                      <Link href={`/jobs/${run.jobId}`} className="rounded-sm underline-offset-4 hover:underline">
                        Results
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.hasNextPage ? (
            <div className="flex justify-center py-2">
              <Button variant="ghost" disabled={runs.isFetchingNextPage} onClick={() => runs.fetchNextPage()}>
                Load more
              </Button>
            </div>
          ) : null}
        </ScrollPane>
      )}
    </section>
  );
}

function MonitorCrumb() {
  return (
    <Crumb>
      <Link href="/monitoring" className="rounded-sm hover:text-foreground">
        Monitor
      </Link>
    </Crumb>
  );
}

export function WatchView({ watchId }: { watchId: string }) {
  const router = useRouter();
  const providers = useProviders();
  const watch = useQuery({
    queryKey: qk.watch(watchId),
    queryFn: ({ signal }) => api.call('getWatch', { params: { id: watchId }, signal }).then((r) => r.data),
    refetchInterval: 30_000,
  });
  const names = new Map((providers.data ?? []).map((p) => [p.id, p.name]));
  // Deleted in another tab: leave the page instead of showing a missing watch.
  useWatchEvents((deletedId) => {
    if (deletedId !== watchId) return;
    if (!watchesDeletedHere.has(deletedId)) toast('This watch was deleted');
    router.replace('/monitoring');
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
        <PageHeader title="Watch" leading={<MonitorCrumb />} />
        <ErrorState error={watch.error} onRetry={() => watch.refetch()} />
      </Page>
    );
  }

  const data = watch.data;
  return (
    <Page>
      <PageHeader
        leading={<MonitorCrumb />}
        title={data.name}
        meta={
          <>
            <StatusLabel status={WATCH_STATE[data.state] ?? { label: data.state, tone: 'muted' }} className="font-medium" />
            <span className="text-muted-foreground">
              {formatInterval(data.intervalMinutes)} · {plural(data.domains.length, 'domain')} · created <RelativeTime iso={data.createdAt} />
            </span>
          </>
        }
        actions={<WatchActions watch={data} onDeleted={() => router.push('/monitoring')} />}
      />

      <div className="flex flex-col gap-8 lg:min-h-0 lg:flex-1 lg:flex-row lg:gap-10">
        <div className="flex min-w-0 flex-col gap-5 lg:min-h-0 lg:w-[22rem] lg:shrink-0">
          <Facts
            className="shrink-0"
            items={[
              ['Last run', data.lastRunAt ? <span key="l" title={formatDateTime(data.lastRunAt)}><RelativeTime iso={data.lastRunAt} /></span> : <span className="text-muted-foreground">Never</span>],
              ['Next run', <NextRun key="n" watch={data} />],
              ['Missed', <span key="m"><MissedRuns count={data.missedRuns} />{data.missedRuns > 0 ? <span className="block text-xs text-muted-foreground">while the backend was stopped</span> : null}</span>],
              ['Registry evidence', data.includeRegistry ? 'Included' : 'Not included'],
              ['Providers', data.providerIds.length ? data.providerIds.map((id) => names.get(id) ?? id).join(', ') : 'None'],
              ['Published prices', data.includeCatalogPrices ? 'Tracked' : 'Not tracked'],
              [
                'Destinations',
                data.destinations.length ? (
                  <span key="d" className="break-all font-mono text-xs">
                    {data.destinations.join(', ')}
                  </span>
                ) : (
                  'None'
                ),
              ],
              ...(data.lastJobId
                ? [
                    [
                      'Last job',
                      <Link key="j" href={`/jobs/${data.lastJobId}`} className="rounded-sm underline-offset-4 hover:underline">
                        Open results
                      </Link>,
                    ] as [string, React.ReactNode],
                  ]
                : []),
            ]}
          />
          <Domains domains={data.domains} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-8 lg:min-h-0">
          <Runs watchId={watchId} />
          <NoticeFeed watchId={watchId} unreadCount={data.unreadNotices} className="lg:min-h-0 lg:flex-1" />
        </div>
      </div>
    </Page>
  );
}
