'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ellipsis, Play, Search, Send, Trash, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { TERMINAL_JOB_STATES, type JobState, type OperationResponse } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { JOB_TYPE, jobStateStatus, jobTypeLabel } from '@/lib/labels';
import { formatCount, plural } from '@/lib/format';
import { qk } from '@/lib/queries';
import { useDebounced } from '@/lib/use-debounced';
import { cn } from '@/lib/utils';
import { useJobStarted } from '../actions/use-job-started';
import { RelativeTime } from '../domain/time';
import { EmptyState, ErrorState } from '../states';
import { StatusLabel } from '../status';
import { ConfirmDialog } from '../ui/alert-dialog';
import { HistoryExportMenu, downloadJobHistoryCsv, downloadJobHistoryJson } from './history-export';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { SkeletonRows } from '../ui/skeleton';

type HistoryEntry = OperationResponse<'listHistory'>['data'][number];

const ANY = '__any__';

function HistoryRow({ entry, onDelete }: { entry: HistoryEntry; onDelete: () => void }) {
  const router = useRouter();
  const client = useQueryClient();
  const started = useJobStarted();
  const finished = TERMINAL_JOB_STATES.includes(entry.state as JobState);
  const resume = useMutation({
    mutationFn: async () => (await api.call('resumeJob', { params: { id: entry.jobId } })).data,
    onSuccess: (job) => {
      started(job, `Resumed ${entry.label ?? jobTypeLabel(entry.type)}`);
      void client.invalidateQueries({ queryKey: qk.history() });
    },
  });
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 rounded-lg px-3 py-3 transition-colors hover:bg-hover sm:grid-cols-[minmax(0,1fr)_9rem_12rem_auto]"
      data-testid="history-row"
    >
      <div className="min-w-0">
        <Link href={`/jobs/${entry.jobId}`} className="block truncate font-medium underline-offset-4 hover:underline">
          {entry.label ?? jobTypeLabel(entry.type)}
        </Link>
        <p className="truncate text-xs text-muted-foreground">
          {entry.label ? `${jobTypeLabel(entry.type)} · ` : ''}
          <RelativeTime iso={entry.createdAt} />
          {entry.extensions.length ? <span className="font-mono"> · {entry.extensions.map((e) => `.${e}`).join(' ')}</span> : null}
        </p>
      </div>
      <span className="hidden text-right font-mono text-xs text-muted-foreground tabular sm:block">
        {plural(entry.total, 'item')}
        {entry.unresolved ? <span className="block">{formatCount(entry.unresolved)} unresolved</span> : null}
      </span>
      <StatusLabel status={jobStateStatus(entry.state)} className="hidden text-sm sm:inline-flex" />
      <div className="row-span-2 flex items-center gap-1 sm:row-span-1">
        {entry.resumable ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={resume.isPending}
            onClick={() => resume.mutate()}
            title={entry.destinations.length ? `Sends names to ${entry.destinations.join(', ')}` : undefined}
            aria-description={entry.destinations.length ? `Sends names to ${entry.destinations.join(', ')}` : undefined}
          >
            <Play />
            Resume
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="quiet" aria-label={`More actions for ${entry.label ?? jobTypeLabel(entry.type)}`}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => router.push(`/jobs/${entry.jobId}`)}>Open results</DropdownMenuItem>
            {entry.type === 'registry_scan' ? (
              <DropdownMenuItem onSelect={() => router.push(`/scan?job=${entry.jobId}`)}>
                <Undo2 />
                Restore input
              </DropdownMenuItem>
            ) : null}
            {finished ? (
              <DropdownMenuItem className="text-negative" onSelect={onDelete}>
                <Trash />
                Delete
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {entry.resumable && entry.destinations.length ? (
        // Resuming contacts these again, so they are stated before the click, not after.
        <p className="col-span-full flex min-w-0 gap-1.5 text-xs text-muted-foreground" data-testid="resume-destinations">
          <Send aria-hidden className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0">
            Resume sends names to <span className="break-all font-mono">{entry.destinations.join(', ')}</span>
          </span>
        </p>
      ) : null}
      <p className="col-start-1 flex gap-3 text-xs sm:hidden">
        <StatusLabel status={jobStateStatus(entry.state)} />
        <span className="font-mono text-muted-foreground tabular">{plural(entry.total, 'item')}</span>
      </p>
    </li>
  );
}

/** Past jobs with restorable inputs. Restoring fills the scan form; it runs nothing. */
export function JobHistory() {
  const client = useQueryClient();
  const [q, setQ] = useState('');
  const [type, setType] = useState(ANY);
  const [deleting, setDeleting] = useState<HistoryEntry | null>(null);
  const search = useDebounced(q.trim(), 300);
  const query = { q: search || undefined, type: type === ANY ? undefined : type };
  const history = useInfiniteQuery({
    queryKey: qk.history(query),
    queryFn: ({ pageParam, signal }) => api.call('listHistory', { query: { ...query, cursor: pageParam, limit: 50 }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
  });
  const rows = history.data?.pages.flatMap((p) => p.data) ?? [];
  const total = history.data?.pages[0]?.total ?? null;
  const exportable = rows.length > 0 && !history.isPlaceholderData && !history.isFetching;
  const loaded = () => ({ contractVersion: history.data?.pages[0]?.contractVersion ?? '', rows, total, complete: !history.hasNextPage });

  const remove = useMutation({
    mutationFn: async (entry: HistoryEntry) => api.call('deleteJob', { params: { id: entry.jobId } }),
    onSuccess: () => {
      toast.success('Job deleted');
      setDeleting(null);
      void client.invalidateQueries({ queryKey: qk.history() });
      void client.invalidateQueries({ queryKey: qk.jobs() });
    },
  });

  return (
    <section aria-label="Job history">
      <div className="mb-4 flex flex-wrap items-center gap-2" role="search" aria-label="Filter history">
        <div className="relative w-full sm:w-72">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" aria-label="Search history" placeholder="Label or domain" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <Select
          aria-label="Type"
          value={type}
          onValueChange={setType}
          className="w-44"
          options={[{ value: ANY, label: 'All types' }, ...Object.entries(JOB_TYPE).map(([value, label]) => ({ value, label }))]}
        />
        {total !== null ? <span className="text-sm text-muted-foreground sm:ml-auto">{plural(total, 'job')}</span> : null}
        <HistoryExportMenu
          label="Export job history"
          disabled={!exportable}
          onJson={() => downloadJobHistoryJson(query, loaded())}
          onCsv={() => downloadJobHistoryCsv(query, loaded())}
        />
      </div>
      {history.isPending ? (
        <SkeletonRows rows={6} />
      ) : history.isError ? (
        <ErrorState error={history.error} onRetry={() => history.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState>{search || type !== ANY ? 'No jobs match.' : 'No jobs yet.'}</EmptyState>
      ) : (
        <ul className={cn('flex flex-col gap-0.5 transition-opacity', history.isPlaceholderData && 'opacity-60')} aria-label="Jobs">
          {rows.map((entry) => (
            <HistoryRow key={entry.jobId} entry={entry} onDelete={() => setDeleting(entry)} />
          ))}
        </ul>
      )}
      {history.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <Button variant="ghost" disabled={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.label ?? (deleting ? jobTypeLabel(deleting.type) : 'job')}?`}
        description="The job and its results list are removed. Evidence used by shortlists or other jobs is kept."
        confirmLabel="Delete job"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </section>
  );
}
