'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PEOPLE_ORIGINS, searchSummary } from '@/lib/history';
import { qk } from '@/lib/queries';
import { RelativeTime } from '../domain/time';
import { Skeleton } from '../ui/skeleton';

export function AgentTag() {
  return <span className="shrink-0 rounded bg-input px-1.5 py-px text-[11px] font-medium text-muted-foreground">Agent</span>;
}

/** The last few searches from this UI and from agents, one click from their results. */
export function RecentSearches() {
  const query = { origins: PEOPLE_ORIGINS, type: 'registry_scan', limit: 8 };
  const history = useQuery({
    queryKey: qk.history(query),
    queryFn: ({ signal }) => api.call('listHistory', { query, signal }).then((r) => r.data),
    refetchInterval: (q) => (q.state.data?.some((e) => e.state === 'running' || e.state === 'queued') ? 4000 : false),
  });
  if (history.isPending) return <Skeleton className="mt-2 h-24 w-full" />;
  if (history.isError || history.data.length === 0) return null;
  return (
    <section aria-label="Recent searches" className="flex min-h-0 flex-col">
      <div className="mb-1 flex items-center justify-between px-2">
        <h2 className="text-xs font-medium text-muted-foreground">Recent searches</h2>
        <Link href="/history" className="rounded-sm text-xs text-muted-foreground hover:text-foreground">
          History
        </Link>
      </div>
      <ul className="flex flex-col">
        {history.data.map((entry) => {
          return (
            <li key={entry.jobId}>
              <Link
                href={`/search/${entry.jobId}`}
                className="focus-inset grid h-9 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 rounded-md px-2 text-sm transition-colors hover:bg-hover"
                data-testid="recent-search"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{entry.label ?? `${entry.total} names`}</span>
                  {entry.origin === 'cli' ? <AgentTag /> : null}
                </span>
                <span className="truncate text-xs text-muted-foreground tabular">{searchSummary(entry)}</span>
                <RelativeTime iso={entry.createdAt} className="w-20 text-right text-xs text-muted-foreground" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
