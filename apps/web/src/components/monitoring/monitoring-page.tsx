'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { Watch } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { useWatchEvents } from '@/lib/events';
import { WATCH_STATE } from '@/lib/labels';
import { formatCount, formatInterval, plural } from '@/lib/format';
import { cn } from '@/lib/utils';
import { qk, useUnreadNoticeCount } from '@/lib/queries';
import { RelativeTime } from '../domain/time';
import { EmptyState, ErrorState, Page, PageHeader, ScrollPane, SectionTitle } from '../states';
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

const WATCH_GRID = 'grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_7rem_7.5rem_7.5rem_7.5rem]';

function WatchRow({ watch }: { watch: Watch }) {
  return (
    <li className={`grid ${WATCH_GRID} min-h-row items-center gap-x-4 gap-y-1 rounded-md px-2.5 py-1 transition-colors hover:bg-hover`} data-testid="watch-row">
      <div className="min-w-0">
        <Link href={`/monitoring/${watch.id}`} className="block truncate rounded-sm font-medium underline-offset-4 hover:underline">
          {watch.name}
        </Link>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono tabular">{plural(watch.domains.length, 'domain')}</span>
          <span>· {formatInterval(watch.intervalMinutes)}</span>
          {watch.unreadNotices > 0 ? <span className="font-medium text-foreground">· {formatCount(watch.unreadNotices)} unread</span> : null}
          {watch.missedRuns > 0 ? (
            <span className="inline-flex items-center gap-1" title="Missed while the backend was stopped">
              · <MissedRuns count={watch.missedRuns} />
            </span>
          ) : null}
        </p>
      </div>
      <StatusLabel status={WATCH_STATE[watch.state] ?? { label: watch.state, tone: 'muted' }} className="max-lg:hidden" />
      <RelativeTime iso={watch.lastRunAt} className={cn('text-xs max-lg:hidden', watch.lastRunAt ? '' : 'text-muted-foreground')} />
      <span className="text-xs max-lg:hidden">
        <NextRun watch={watch} />
      </span>
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
      </p>
    </li>
  );
}

export function MonitoringPage() {
  const [creating, setCreating] = useState(false);
  const unread = useUnreadNoticeCount();
  useWatchEvents();
  const watches = useInfiniteQuery({
    queryKey: qk.watches,
    queryFn: ({ pageParam, signal }) => api.call('listWatches', { query: { cursor: pageParam, limit: 100 }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const rows = watches.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <Page>
      <PageHeader
        title="Monitor"
        meta={
          watches.data ? (
            <span className="text-muted-foreground">
              <span className="font-mono tabular">{formatCount(rows.length)}</span> {rows.length === 1 ? 'watch' : 'watches'}
              {unread > 0 ? (
                <>
                  {' · '}
                  <span className="font-mono text-foreground tabular">{formatCount(unread)}</span> unread
                </>
              ) : null}
            </span>
          ) : null
        }
        actions={
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            <Plus />
            New watch
          </Button>
        }
      />
      <div className="flex flex-col gap-8 lg:min-h-0 lg:flex-1">
        <section aria-label="Watches" className="flex min-w-0 flex-col lg:max-h-[45%] lg:min-h-0 lg:shrink-0">
          <div className={`grid ${WATCH_GRID} h-8 shrink-0 items-center gap-x-4 px-2.5 text-xs font-medium text-muted-foreground`}>
            <SectionTitle className="mb-0 text-sm text-foreground">Watches</SectionTitle>
            <span className="max-lg:hidden">State</span>
            <span className="max-lg:hidden">Last run</span>
            <span className="max-lg:hidden">Next run</span>
            <span className="max-lg:hidden" />
          </div>
          {watches.isPending ? (
            <SkeletonRows rows={4} />
          ) : watches.isError ? (
            <ErrorState error={watches.error} onRetry={() => watches.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState>No watches yet.</EmptyState>
          ) : (
            <ScrollPane>
              <ul className="flex flex-col" aria-label="Watch list">
                {rows.map((watch) => (
                  <WatchRow key={watch.id} watch={watch} />
                ))}
              </ul>
              {watches.hasNextPage ? (
                <div className="flex justify-center py-2">
                  <Button variant="ghost" disabled={watches.isFetchingNextPage} onClick={() => watches.fetchNextPage()}>
                    Load more
                  </Button>
                </div>
              ) : null}
            </ScrollPane>
          )}
        </section>
        <NoticeFeed unreadCount={unread} className="lg:min-h-0 lg:flex-1" />
      </div>
      <WatchFormDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}
