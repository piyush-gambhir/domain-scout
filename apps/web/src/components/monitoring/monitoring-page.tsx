'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { Watch } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { WATCH_STATE } from '@/lib/labels';
import { formatCount, formatInterval, plural } from '@/lib/format';
import { qk, useUnreadNoticeCount } from '@/lib/queries';
import { RelativeTime } from '../domain/time';
import { EmptyState, ErrorState, PageHeader, SectionTitle } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { SkeletonRows } from '../ui/skeleton';
import { NoticeFeed } from './notices';
import { WatchActions } from './watch-actions';
import { WatchFormDialog } from './watch-form';

/** Next run in words; a paused watch has none. */
export function NextRun({ watch }: { watch: Watch }) {
  if (watch.state === 'paused') return <span className="text-muted-foreground">Paused</span>;
  if (!watch.nextRunAt) return <span className="text-muted-foreground">Not scheduled</span>;
  return <RelativeTime iso={watch.nextRunAt} />;
}

export function MissedRuns({ count }: { count: number }) {
  if (count === 0) return <span className="text-muted-foreground">None missed</span>;
  return <StatusLabel status={{ label: plural(count, 'missed run'), tone: 'caution', unresolved: true }} />;
}

function WatchRow({ watch }: { watch: Watch }) {
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 rounded-lg px-3 py-3 transition-colors hover:bg-hover lg:grid-cols-[minmax(0,1fr)_7rem_8rem_8rem_auto]"
      data-testid="watch-row"
    >
      <div className="min-w-0">
        <Link href={`/monitoring/${watch.id}`} className="block truncate font-medium underline-offset-4 hover:underline">
          {watch.name}
        </Link>
        <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono tabular">{plural(watch.domains.length, 'domain')}</span>
          <span>· {formatInterval(watch.intervalMinutes)}</span>
          {watch.unreadNotices > 0 ? <span className="font-medium text-foreground">· {formatCount(watch.unreadNotices)} unread</span> : null}
        </p>
      </div>
      <StatusLabel status={WATCH_STATE[watch.state] ?? { label: watch.state, tone: 'muted' }} className="text-sm max-lg:hidden" />
      <div className="text-xs max-lg:hidden">
        <p className="text-muted-foreground">Last run</p>
        <RelativeTime iso={watch.lastRunAt} className={watch.lastRunAt ? '' : 'text-muted-foreground'} />
      </div>
      <div className="text-xs max-lg:hidden">
        <p className="text-muted-foreground">Next run</p>
        <NextRun watch={watch} />
      </div>
      <div className="row-span-2 flex items-center justify-end lg:row-span-1">
        <WatchActions watch={watch} compact />
      </div>
      <p className="col-start-1 flex flex-wrap gap-x-3 text-xs lg:hidden">
        <StatusLabel status={WATCH_STATE[watch.state] ?? { label: watch.state, tone: 'muted' }} />
        {watch.state === 'paused' ? null : (
          <span>
            <span className="text-muted-foreground">Next </span>
            <NextRun watch={watch} />
          </span>
        )}
        {watch.missedRuns > 0 ? <MissedRuns count={watch.missedRuns} /> : null}
      </p>
      {watch.missedRuns > 0 ? (
        <p className="col-span-full text-xs max-lg:hidden">
          <MissedRuns count={watch.missedRuns} />
          <span className="text-muted-foreground"> while the backend was stopped</span>
        </p>
      ) : null}
    </li>
  );
}

export function MonitoringPage() {
  const [creating, setCreating] = useState(false);
  const unread = useUnreadNoticeCount();
  const watches = useInfiniteQuery({
    queryKey: qk.watches,
    queryFn: ({ pageParam, signal }) => api.call('listWatches', { query: { cursor: pageParam, limit: 100 }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const rows = watches.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader
        title="Monitor"
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus />
            New watch
          </Button>
        }
      />
      <section aria-label="Watches">
        <SectionTitle>Watches</SectionTitle>
        {watches.isPending ? (
          <SkeletonRows rows={4} />
        ) : watches.isError ? (
          <ErrorState error={watches.error} onRetry={() => watches.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState className="py-6 text-left">No watches yet.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-0.5" aria-label="Watch list">
            {rows.map((watch) => (
              <WatchRow key={watch.id} watch={watch} />
            ))}
          </ul>
        )}
        {watches.hasNextPage ? (
          <div className="mt-3 flex justify-center">
            <Button variant="ghost" disabled={watches.isFetchingNextPage} onClick={() => watches.fetchNextPage()}>
              Load more
            </Button>
          </div>
        ) : null}
      </section>
      <div className="mt-12">
        <NoticeFeed unreadCount={unread} />
      </div>
      <WatchFormDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
