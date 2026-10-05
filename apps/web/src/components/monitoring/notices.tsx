'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCheck } from 'lucide-react';
import { toast } from 'sonner';
import type { Notice } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { NOTICE_TYPE, evidenceStatus, humanize } from '@/lib/labels';
import { formatDateTime, plural } from '@/lib/format';
import { qk } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { RelativeTime } from '../domain/time';
import { EmptyState, ErrorState, SectionTitle } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { Segmented } from '../ui/segmented';
import { SkeletonRows } from '../ui/skeleton';

type EvidenceRef = Notice['before'];

/** Marking notices read refreshes every notice list, watch unread counts and the sidebar badge. */
export function useMarkNoticesRead() {
  const client = useQueryClient();
  return useMutation({
    /** `{ all: true, watchId }` marks every notice of one watch read; `{ all: true }` marks every notice. */
    mutationFn: async (body: { ids?: string[]; all?: boolean; watchId?: string }) => api.call('markNoticesRead', { body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.notices });
      void client.invalidateQueries({ queryKey: qk.watches });
    },
  });
}

function Evidence({ label, evidence }: { label: string; evidence: EvidenceRef }) {
  const status = evidenceStatus(evidence.kind, evidence.value);
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-medium">{status ? <StatusLabel status={status} /> : <span className="font-mono">{evidence.value}</span>}</p>
      <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-muted-foreground" title={`${evidence.source}, ${formatDateTime(evidence.observedAt)}`}>
        <span className="min-w-0 break-all font-mono">{evidence.source}</span>
        <RelativeTime iso={evidence.observedAt} />
      </p>
    </div>
  );
}

function NoticeItem({ notice, onRead, pending, showWatch }: { notice: Notice; onRead: () => void; pending: boolean; showWatch?: boolean }) {
  const unread = notice.readAt === null;
  return (
    <li className={cn('rounded-lg px-3 py-3', unread && 'bg-hover')} data-testid="notice">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {notice.domain.startsWith('.') ? (
          // Catalog price notices are about a whole extension, not one domain.
          <Link href="/history?view=prices" className={cn('font-mono text-sm underline-offset-4 hover:underline', unread && 'font-semibold')}>
            {notice.domain}
          </Link>
        ) : (
          <Link href={`/domains/${encodeURIComponent(notice.domain)}`} className={cn('font-mono text-sm underline-offset-4 hover:underline', unread && 'font-semibold')}>
            {notice.domain}
          </Link>
        )}
        <span className="text-sm">{NOTICE_TYPE[notice.type] ?? humanize(notice.type)}</span>
        {unread ? <span className="text-xs font-medium">Unread</span> : null}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <RelativeTime iso={notice.createdAt} />
          {showWatch ? (
            <Link href={`/monitoring/${notice.watchId}`} className="underline-offset-4 hover:text-foreground hover:underline">
              Watch
            </Link>
          ) : null}
          {unread ? (
            <Button size="sm" variant="quiet" className="h-7 px-2" disabled={pending} onClick={onRead} aria-label={`Mark ${notice.domain} notice read`}>
              Mark read
            </Button>
          ) : null}
        </span>
      </div>
      {notice.summary ? <p className="mt-1 text-sm text-muted-foreground">{notice.summary}</p> : null}
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-x-3 text-sm sm:max-w-xl">
        <Evidence label="Before" evidence={notice.before} />
        <ArrowRight aria-hidden className="mt-5 size-4 text-muted-foreground" />
        <Evidence label="After" evidence={notice.after} />
      </div>
    </li>
  );
}

/** Change notices with before and after evidence. Scoped to one watch, or every watch. */
export function NoticeFeed({ watchId, unreadCount, title = 'Notices' }: { watchId?: string; unreadCount: number; title?: string }) {
  const [view, setView] = useState<'all' | 'unread'>('all');
  const query = { watchId, unread: view === 'unread' ? ('true' as const) : undefined };
  const notices = useInfiniteQuery({
    queryKey: qk.noticeList(query),
    queryFn: ({ pageParam, signal }) => api.call('listNotices', { query: { ...query, cursor: pageParam, limit: 50 }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const rows = notices.data?.pages.flatMap((p) => p.data) ?? [];
  const unreadLoaded = rows.filter((n) => n.readAt === null);
  const markRead = useMarkNoticesRead();

  const markAll = () => markRead.mutate(watchId ? { all: true, watchId } : { all: true }, { onSuccess: () => toast.success('Notices marked read') });


  return (
    <section aria-label={title}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SectionTitle className="mb-0">{title}</SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            aria-label="Show notices"
            size="sm"
            value={view}
            onValueChange={setView}
            options={[
              { value: 'all', label: 'All' },
              { value: 'unread', label: 'Unread' },
            ]}
          />
          <Button size="sm" variant="secondary" disabled={markRead.isPending || (unreadCount === 0 && unreadLoaded.length === 0)} onClick={markAll}>
            <CheckCheck />
            Mark all read
          </Button>
        </div>
      </div>
      {notices.isPending ? (
        <SkeletonRows rows={3} />
      ) : notices.isError ? (
        <ErrorState error={notices.error} onRetry={() => notices.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState className="py-6 text-left">{view === 'unread' ? 'No unread notices.' : 'No notices.'}</EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-1" aria-label="Notice list">
            {rows.map((notice) => (
              <NoticeItem
                key={notice.id}
                notice={notice}
                showWatch={!watchId}
                pending={markRead.isPending}
                onRead={() => markRead.mutate({ ids: [notice.id] })}
              />
            ))}
          </ul>
          {notices.hasNextPage ? (
            <div className="mt-3 flex justify-center">
              <Button variant="ghost" disabled={notices.isFetchingNextPage} onClick={() => notices.fetchNextPage()}>
                Load more
              </Button>
            </div>
          ) : null}
          {(notices.data?.pages[0]?.total ?? null) !== null ? (
            <p className="mt-2 text-xs text-muted-foreground">{plural(notices.data!.pages[0]!.total!, 'notice')}</p>
          ) : null}
        </>
      )}
    </section>
  );
}
