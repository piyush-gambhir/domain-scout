'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useWatchEvents, watchesDeletedHere } from '@/lib/events';
import { WATCH_STATE, watchRunStatus } from '@/lib/labels';
import { formatCount, formatDateTime, formatInterval, plural } from '@/lib/format';
import { qk, useProviders } from '@/lib/queries';
import { RelativeTime } from '../domain/time';
import { EmptyState, ErrorState, Facts, PageHeader, SectionTitle } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { Skeleton, SkeletonRows } from '../ui/skeleton';
import { MissedRuns, NextRun } from './monitoring-page';
import { NoticeFeed } from './notices';
import { WatchActions } from './watch-actions';

const DOMAIN_PREVIEW = 24;

function Domains({ domains }: { domains: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? domains : domains.slice(0, DOMAIN_PREVIEW);
  return (
    <div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[13px]">
        {shown.map((domain) => (
          <li key={domain}>
            <Link href={`/domains/${encodeURIComponent(domain)}`} className="underline-offset-4 hover:underline">
              {domain}
            </Link>
          </li>
        ))}
      </ul>
      {domains.length > DOMAIN_PREVIEW ? (
        <Button size="sm" variant="link" className="mt-2 text-muted-foreground" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${formatCount(domains.length)}`}
        </Button>
      ) : null}
    </div>
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
    <section aria-label="Runs">
      <SectionTitle>Runs</SectionTitle>
      {runs.isPending ? (
        <SkeletonRows rows={4} />
      ) : runs.isError ? (
        <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState className="py-6 text-left">No runs yet.</EmptyState>
      ) : (
        <div className="relative -mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                {['Status', 'Scheduled for', 'Ran', 'Changes', 'Failures', ''].map((h, i) => (
                  <th key={i} scope="col" className="pb-2 pr-4 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => (
                <tr key={run.id} className="align-top" data-testid="watch-run">
                  <td className="py-2 pr-4">
                    <StatusLabel status={watchRunStatus(run.status)} />
                    {run.note ? <span className="block max-w-64 text-xs text-muted-foreground">{run.note}</span> : null}
                  </td>
                  <td className="py-2 pr-4 text-muted-foreground">{formatDateTime(run.scheduledFor)}</td>
                  <td className="py-2 pr-4">
                    {run.startedAt ? (
                      <span title={formatDateTime(run.startedAt)}>
                        <RelativeTime iso={run.startedAt} />
                        {run.finishedAt ? null : <span className="text-muted-foreground"> · not finished</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Did not run</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 font-mono tabular">{run.startedAt ? formatCount(run.changes) : <span className="text-muted-foreground">None</span>}</td>
                  <td className="py-2 pr-4 font-mono tabular">{run.startedAt ? formatCount(run.failures) : <span className="text-muted-foreground">None</span>}</td>
                  <td className="py-2 pr-1 text-right">
                    {run.jobId ? (
                      <Link href={`/jobs/${run.jobId}`} className="text-sm underline-offset-4 hover:underline">
                        Results
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {runs.hasNextPage ? (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" disabled={runs.isFetchingNextPage} onClick={() => runs.fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}
    </section>
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

  const back = (
    <Link href="/monitoring" className="mb-3 inline-block rounded-sm text-sm text-muted-foreground hover:text-foreground">
      Monitor
    </Link>
  );

  if (watch.isPending) {
    return (
      <>
        {back}
        <Skeleton className="mb-6 h-7 w-56" />
        <SkeletonRows rows={6} />
      </>
    );
  }
  if (watch.isError) {
    return (
      <>
        {back}
        <PageHeader title="Watch" />
        <ErrorState error={watch.error} onRetry={() => watch.refetch()} />
      </>
    );
  }

  const data = watch.data;
  return (
    <>
      {back}
      <PageHeader title={data.name} actions={<WatchActions watch={data} onDeleted={() => router.push('/monitoring')} />}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <StatusLabel status={WATCH_STATE[data.state] ?? { label: data.state, tone: 'muted' }} className="font-medium" />
          <span className="text-muted-foreground">
            {formatInterval(data.intervalMinutes)} · {plural(data.domains.length, 'domain')} · created <RelativeTime iso={data.createdAt} />
          </span>
        </div>
      </PageHeader>

      <Facts
        className="max-w-3xl"
        items={[
          ['Last run', data.lastRunAt ? <span key="l" title={formatDateTime(data.lastRunAt)}><RelativeTime iso={data.lastRunAt} /></span> : <span className="text-muted-foreground">Never</span>],
          ['Next run', <NextRun key="n" watch={data} />],
          ['Missed', <span key="m"><MissedRuns count={data.missedRuns} />{data.missedRuns > 0 ? <span className="text-muted-foreground"> while the backend was stopped</span> : null}</span>],
          ['Registry evidence', data.includeRegistry ? 'Included' : 'Not included'],
          ['Providers', data.providerIds.length ? data.providerIds.map((id) => names.get(id) ?? id).join(', ') : 'None'],
          ['Published prices', data.includeCatalogPrices ? 'Tracked' : 'Not tracked'],
          [
            'Destinations',
            data.destinations.length ? (
              <span key="d" className="font-mono text-[13px]">
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
                  <Link key="j" href={`/jobs/${data.lastJobId}`} className="underline-offset-4 hover:underline">
                    Open results
                  </Link>,
                ] as [string, React.ReactNode],
              ]
            : []),
        ]}
      />

      <section className="mt-10" aria-label="Domains">
        <SectionTitle>Domains</SectionTitle>
        <Domains domains={data.domains} />
      </section>

      <div className="mt-10">
        <Runs watchId={watchId} />
      </div>
      <div className="mt-10">
        <NoticeFeed watchId={watchId} unreadCount={data.unreadNotices} />
      </div>
    </>
  );
}
