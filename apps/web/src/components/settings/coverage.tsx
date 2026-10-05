'use client';

import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { CoverageStatus } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import type { StatusInfo } from '@/lib/labels';
import { formatCount, formatDate, formatDateTime, hostOf, plural } from '@/lib/format';
import { qk } from '@/lib/queries';
import { useDebounced } from '@/lib/use-debounced';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, ScrollPane, SectionTitle } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Segmented } from '../ui/segmented';
import { Skeleton, SkeletonRows } from '../ui/skeleton';

const COVERAGE_STATUS: Record<CoverageStatus, StatusInfo> = {
  tested: { label: 'Tested', tone: 'positive' },
  discovered: { label: 'Discovered, untested', tone: 'caution' },
  unsupported: { label: 'Unsupported', tone: 'muted' },
};
const ROUTING: Record<string, string> = { iana_bootstrap: 'IANA bootstrap', curated: 'Curated' };

/** What the counts do and do not show. The first limit is always visible; the rest open on request. */
function Limits({ limits }: { limits: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? limits : limits.slice(0, 1);
  return (
    <div className="flex max-w-4xl flex-col items-start gap-0.5 text-xs text-muted-foreground">
      <ul className="flex flex-col gap-0.5" aria-label="Coverage limits">
        {shown.map((limit) => (
          <li key={limit}>{limit}</li>
        ))}
      </ul>
      {limits.length > 1 ? (
        <Button size="sm" variant="link" className="text-xs text-foreground" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? 'Fewer limits' : `${limits.length - 1} more ${limits.length === 2 ? 'limit' : 'limits'}`}
        </Button>
      ) : null}
    </div>
  );
}

function Summary() {
  const client = useQueryClient();
  const summary = useQuery({
    queryKey: [...qk.coverage, 'summary'],
    queryFn: ({ signal }) => api.call('getCoverageSummary', { signal }).then((r) => r.data),
  });
  const refresh = useMutation({
    mutationFn: async () => (await api.call('refreshCoverage')).data,
    onSuccess: (data) => {
      client.setQueryData([...qk.coverage, 'summary'], data);
      void client.invalidateQueries({ queryKey: [...qk.coverage, 'list'] });
      toast.success('Coverage refreshed');
    },
  });
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SectionTitle className="mb-0">Coverage</SectionTitle>
        {summary.isSuccess ? (
          <dl className="flex flex-wrap gap-x-4 text-sm" data-testid="coverage-counts">
            {(['tested', 'discovered', 'unsupported'] as const).map((status) => (
              <div key={status} className="flex items-baseline gap-1.5">
                <dt className="text-muted-foreground">{COVERAGE_STATUS[status].label}</dt>
                <dd className="font-mono tabular">{formatCount(summary.data.counts[status])}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <Button size="sm" variant="secondary" className="ml-auto" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          <RefreshCw className={cn(refresh.isPending && 'motion-safe:animate-spin')} />
          Refresh from IANA
        </Button>
      </div>
      {summary.isPending ? (
        <Skeleton className="h-16 max-w-xl" />
      ) : summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            IANA published {formatDateTime(summary.data.bootstrapPublishedAt)} · fetched {formatDateTime(summary.data.bootstrapFetchedAt)}
          </p>
          {summary.data.limits.length > 0 ? <Limits limits={summary.data.limits} /> : null}
        </>
      )}
    </div>
  );
}

function CoverageList() {
  const [status, setStatus] = useState<'all' | CoverageStatus>('all');
  const [q, setQ] = useState('');
  const search = useDebounced(q.trim().toLowerCase().replace(/^\.+/, ''), 300);
  const query = { status: status === 'all' ? undefined : status, q: search || undefined };
  const list = useInfiniteQuery({
    queryKey: [...qk.coverage, 'list', query],
    queryFn: ({ pageParam, signal }) => api.call('listCoverage', { query: { ...query, cursor: pageParam, limit: 200 }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const total = list.data?.pages[0]?.total ?? null;
  return (
    <div className="flex min-w-0 flex-col gap-2 lg:min-h-0 lg:flex-1">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5" role="search" aria-label="Filter coverage">
        <div className="relative w-full sm:w-48">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" aria-label="Search extensions" placeholder="Extension" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8 font-mono" />
        </div>
        <Segmented
          aria-label="Coverage status"
          value={status}
          onValueChange={setStatus}
          options={[
            { value: 'all', label: 'All' },
            { value: 'tested', label: 'Tested' },
            { value: 'discovered', label: 'Discovered' },
            { value: 'unsupported', label: 'Unsupported' },
          ]}
        />
        {total !== null ? <span className="text-sm text-muted-foreground tabular sm:ml-auto">{plural(total, 'extension')}</span> : null}
      </div>
      {list.isPending ? (
        <SkeletonRows rows={8} />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState>No extensions match.</EmptyState>
      ) : (
        <ScrollPane className={cn('overflow-x-auto transition-opacity', list.isPlaceholderData && 'opacity-60')} data-testid="coverage-scroll">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="text-xs text-muted-foreground">
                {['Extension', 'Status', 'Protocol', 'Destination', 'Routing', 'Validation'].map((h) => (
                  <th key={h} scope="col" className="h-8 pr-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.suffix} className="h-8 align-middle" data-testid="coverage-row">
                  <td className="pr-3 font-mono">.{row.suffix}</td>
                  <td className="pr-3">
                    <StatusLabel status={COVERAGE_STATUS[row.status]} />
                  </td>
                  <td className="pr-3">{row.protocol ? row.protocol.toUpperCase() : <span className="text-muted-foreground">None</span>}</td>
                  <td className="max-w-56 truncate pr-3 font-mono text-[13px]" title={row.endpoint ?? undefined}>
                    {row.endpoint ? hostOf(row.endpoint) : <span className="font-sans text-muted-foreground">None</span>}
                  </td>
                  <td className="whitespace-nowrap pr-3 text-muted-foreground">{row.routing ? (ROUTING[row.routing] ?? row.routing) : 'None'}</td>
                  <td className="max-w-72 truncate pr-3 text-muted-foreground" title={row.notes ?? undefined}>
                    {[row.fixtureTested ? 'Fixtures' : null, row.liveValidatedAt ? `live ${formatDate(row.liveValidatedAt)}` : null].filter(Boolean).join(', ') || 'None'}
                    {row.notes ? <span className="text-xs"> · {row.notes}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.hasNextPage ? (
            <div className="flex justify-center py-2">
              <Button variant="ghost" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                Load more
              </Button>
            </div>
          ) : null}
        </ScrollPane>
      )}
    </div>
  );
}

export function CoverageSettings() {
  return (
    <section aria-label="Coverage" className="flex min-w-0 flex-col gap-4 lg:min-h-0 lg:flex-1">
      <Summary />
      <CoverageList />
    </section>
  );
}
