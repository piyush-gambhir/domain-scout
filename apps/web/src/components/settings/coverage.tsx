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
import { EmptyState, ErrorState, Facts, SectionTitle } from '../states';
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
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SectionTitle className="mb-0">Coverage</SectionTitle>
        <Button size="sm" variant="secondary" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          <RefreshCw className={cn(refresh.isPending && 'motion-safe:animate-spin')} />
          Refresh from IANA
        </Button>
      </div>
      {summary.isPending ? (
        <Skeleton className="h-28 max-w-xl" />
      ) : summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : (
        <>
          <dl className="flex flex-wrap gap-x-10 gap-y-3" data-testid="coverage-counts">
            {(['tested', 'discovered', 'unsupported'] as const).map((status) => (
              <div key={status}>
                <dt className="text-xs text-muted-foreground">{COVERAGE_STATUS[status].label}</dt>
                <dd className="font-mono text-lg tabular">{formatCount(summary.data.counts[status])}</dd>
              </div>
            ))}
          </dl>
          <Facts
            className="mt-5 max-w-xl"
            items={[
              ['IANA published', formatDateTime(summary.data.bootstrapPublishedAt)],
              ['Fetched', formatDateTime(summary.data.bootstrapFetchedAt)],
            ]}
          />
          {summary.data.limits.length > 0 ? (
            <ul className="mt-4 flex max-w-2xl flex-col gap-1 text-sm text-muted-foreground" aria-label="Coverage limits">
              {summary.data.limits.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          ) : null}
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
    <div className="mt-10">
      <div className="mb-3 flex flex-wrap items-center gap-2" role="search" aria-label="Filter coverage">
        <div className="relative w-full sm:w-56">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" aria-label="Search extensions" placeholder="Extension" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9 font-mono" />
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
        {total !== null ? <span className="text-sm text-muted-foreground sm:ml-auto">{plural(total, 'extension')}</span> : null}
      </div>
      {list.isPending ? (
        <SkeletonRows rows={6} />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState>No extensions match.</EmptyState>
      ) : (
        <div className={cn('relative -mx-1 overflow-x-auto px-1 transition-opacity', list.isPlaceholderData && 'opacity-60')}>
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                {['Extension', 'Status', 'Protocol', 'Destination', 'Routing', 'Validation'].map((h) => (
                  <th key={h} scope="col" className="pb-2 pr-4 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.suffix} className="align-top" data-testid="coverage-row">
                  <td className="py-1.5 pr-4 font-mono">.{row.suffix}</td>
                  <td className="py-1.5 pr-4">
                    <StatusLabel status={COVERAGE_STATUS[row.status]} />
                  </td>
                  <td className="py-1.5 pr-4">{row.protocol ? row.protocol.toUpperCase() : <span className="text-muted-foreground">None</span>}</td>
                  <td className="max-w-56 truncate py-1.5 pr-4 font-mono text-[13px]" title={row.endpoint ?? undefined}>
                    {row.endpoint ? hostOf(row.endpoint) : <span className="font-sans text-muted-foreground">None</span>}
                  </td>
                  <td className="py-1.5 pr-4 text-muted-foreground">{row.routing ? (ROUTING[row.routing] ?? row.routing) : 'None'}</td>
                  <td className="py-1.5 pr-4 text-muted-foreground">
                    {[row.fixtureTested ? 'Fixtures' : null, row.liveValidatedAt ? `live ${formatDate(row.liveValidatedAt)}` : null].filter(Boolean).join(', ') || 'None'}
                    {row.notes ? (
                      <span className="block max-w-72 truncate text-xs" title={row.notes}>
                        {row.notes}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage ? (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function CoverageSettings() {
  return (
    <section aria-label="Coverage">
      <Summary />
      <CoverageList />
    </section>
  );
}
