'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { Notice, Watch } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { useWatchEvents } from '@/lib/events';
import { NOTICE_TYPE, WATCH_STATE, humanize, registryStatus, type StatusInfo } from '@/lib/labels';
import { formatCount, formatDateTime, formatInterval, plural } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { qk, useUnreadNoticeCount } from '@/lib/queries';
import { RelativeTime } from '../domain/time';
import { NoticeFeed } from './notices';
import { WatchActions } from './watch-actions';
import { WatchFormDialog } from './watch-form';
import { ErrorState, Page } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { SkeletonRows } from '../ui/skeleton';

/** Next check in words, including its lead word; a paused watch has none and an overdue one is due. */
export function NextRun({ watch }: { watch: Watch }) {
  const now = useNow();
  if (watch.state === 'paused') return <span className="text-muted-foreground">Paused</span>;
  if (!watch.nextRunAt) return <span className="text-muted-foreground">Not scheduled</span>;
  if (new Date(watch.nextRunAt).getTime() <= now) return <span title={formatDateTime(watch.nextRunAt)}>check due</span>;
  return (
    <span>
      next <RelativeTime iso={watch.nextRunAt} />
    </span>
  );
}

export function MissedRuns({ count }: { count: number }) {
  if (count === 0) return <span className="text-muted-foreground">None missed</span>;
  return <StatusLabel status={{ label: plural(count, 'missed check'), tone: 'caution', unresolved: true }} />;
}

/** The newest notice per watch: what changed last. */
function useLastChanges() {
  const notices = useQuery({
    queryKey: qk.noticeList({ latest: true }),
    queryFn: ({ signal }) => api.call('listNotices', { query: { limit: 200 }, signal }).then((r) => r.data),
    refetchInterval: 30_000,
  });
  return useMemo(() => {
    const map = new Map<string, Notice>();
    for (const notice of notices.data ?? []) {
      const current = map.get(notice.watchId);
      if (!current || current.createdAt < notice.createdAt) map.set(notice.watchId, notice);
    }
    return map;
  }, [notices.data]);
}

/** Outcome order in a watch's summary: free names first. */
const SUMMARY_ORDER = ['no_record', 'registered', 'inconclusive', 'rate_limited', 'blocked', 'invalid', 'unsupported'];
const rank = (outcome: string) => (SUMMARY_ORDER.includes(outcome) ? SUMMARY_ORDER.indexOf(outcome) : SUMMARY_ORDER.length);

/**
 * Current registry state of the watched names from each name's latest check: the plain status for
 * one name, counts per status for several (e.g. "2 not registered · 3 taken"). The dot takes the
 * tone of the first group, so any free name shows first.
 */
function NamesState({ watch }: { watch: Watch }) {
  const { outcomes, unchecked } = watch.registry;
  const entries = Object.entries(outcomes).sort(([a], [b]) => rank(a) - rank(b));
  if (watch.domains.length === 1) {
    return entries[0] ? <StatusLabel status={registryStatus(entries[0][0])} className="shrink-0 text-xs" /> : null;
  }
  const groups = new Map<string, { status: StatusInfo; n: number }>();
  for (const [outcome, n] of entries) {
    const status = registryStatus(outcome);
    const group = groups.get(status.label);
    if (group) group.n += n;
    else groups.set(status.label, { status, n });
  }
  if (groups.size === 0) return null;
  if (unchecked > 0) groups.set('Not checked', { status: { label: 'Not checked', tone: 'muted', unresolved: true }, n: unchecked });
  const parts = [...groups.values()];
  const text = parts.map(({ status, n }) => `${formatCount(n)} ${status.label.toLowerCase()}`).join(' · ');
  return (
    <span title={text} className="min-w-0 text-xs" data-testid="watch-names-state">
      <StatusLabel status={{ ...parts[0]!.status, label: text }} />
    </span>
  );
}

function WatchRow({ watch, lastChange }: { watch: Watch; lastChange: Notice | undefined }) {
  const preview = watch.domains.slice(0, 3).join(', ');
  const names = watch.name === preview || watch.domains.length === 1 ? null : `${preview}${watch.domains.length > 3 ? ` +${watch.domains.length - 3}` : ''}`;
  return (
    <li className="group/row grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 rounded-md px-2.5 py-2 transition-colors hover:bg-hover" data-testid="watch-row">
      <div className="min-w-0">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <Link href={`/watching/${watch.id}`} className="truncate rounded-sm font-medium underline-offset-4 hover:underline">
            {watch.name}
          </Link>
          {watch.unreadNotices > 0 ? (
            <span className="shrink-0 rounded-full bg-primary px-1.5 text-[11px] font-medium leading-[18px] text-primary-foreground tabular">
              {formatCount(watch.unreadNotices)}
              <span className="sr-only"> unread</span>
            </span>
          ) : null}
          <NamesState watch={watch} />
          {watch.state === 'paused' ? <StatusLabel status={WATCH_STATE.paused!} className="ml-1 shrink-0 text-xs text-muted-foreground" /> : null}
        </p>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {names ? <span className="max-w-[24rem] truncate font-mono">{names}</span> : null}
          {names ? <span aria-hidden>·</span> : null}
          <span>{formatInterval(watch.intervalMinutes)}</span>
          <span aria-hidden>·</span>
          <span>checked {watch.lastRunAt ? <RelativeTime iso={watch.lastRunAt} /> : 'never'}</span>
          {watch.state === 'active' && watch.nextRunAt ? (
            <>
              <span aria-hidden>·</span>
              <NextRun watch={watch} />
            </>
          ) : null}
          {watch.missedRuns > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span title="Missed while the backend was stopped">
                <MissedRuns count={watch.missedRuns} />
              </span>
            </>
          ) : null}
        </p>
        {lastChange ? (
          <p className="truncate text-xs" title={lastChange.summary}>
            <span className="text-muted-foreground">Last change </span>
            <span className="font-mono">{lastChange.domain}</span> {(NOTICE_TYPE[lastChange.type] ?? humanize(lastChange.type)).toLowerCase()} <RelativeTime iso={lastChange.createdAt} className="text-muted-foreground" />
          </p>
        ) : null}
      </div>
      <WatchActions watch={watch} compact />
    </li>
  );
}

/** Names you are waiting on, and an inbox of what changed. */
export function WatchingPage() {
  const [creating, setCreating] = useState(false);
  const unread = useUnreadNoticeCount();
  const lastChanges = useLastChanges();
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
      <div className="flex flex-col gap-8 lg:min-h-0 lg:flex-1 lg:flex-row lg:gap-10">
        <section aria-label="Watches" className="flex min-w-0 flex-col gap-2 lg:min-h-0 lg:flex-[3]">
          <header className="flex shrink-0 items-center justify-between gap-3 px-2.5">
            <h1 className="flex items-baseline gap-2 text-base font-semibold tracking-tight">
              Watching
              {watches.data ? <span className="text-sm font-normal text-muted-foreground tabular">{formatCount(rows.length)}</span> : null}
            </h1>
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
              <Plus />
              New watch
            </Button>
          </header>
          {watches.isPending ? (
            <SkeletonRows rows={4} />
          ) : watches.isError ? (
            <ErrorState error={watches.error} onRetry={() => watches.refetch()} />
          ) : rows.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12">
              <p className="text-sm text-muted-foreground">Nothing watched yet.</p>
              <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                Watch a name
              </Button>
            </div>
          ) : (
            <div className="relative -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
              <ul className="flex flex-col gap-0.5" aria-label="Watch list">
                {rows.map((watch) => (
                  <WatchRow key={watch.id} watch={watch} lastChange={lastChanges.get(watch.id)} />
                ))}
              </ul>
              {watches.hasNextPage ? (
                <div className="flex justify-center py-2">
                  <Button variant="ghost" disabled={watches.isFetchingNextPage} onClick={() => watches.fetchNextPage()}>
                    Load more
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </section>
        <NoticeFeed title="Changes" unreadCount={unread} className="lg:min-h-0 lg:flex-[2]" />
      </div>
      <WatchFormDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}
