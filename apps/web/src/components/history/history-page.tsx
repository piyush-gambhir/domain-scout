'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ellipsis, Play, RotateCcw, Search, Send, Trash, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { TERMINAL_JOB_STATES, type Job, type JobState, type OperationResponse } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { PEOPLE_ORIGINS, searchSummary, useJobSummaries } from '@/lib/history';
import { JOB_TYPE, jobStateStatus, jobTypeLabel } from '@/lib/labels';
import { plural } from '@/lib/format';
import { qk } from '@/lib/queries';
import { useDebounced } from '@/lib/use-debounced';
import { useIdempotency } from '@/lib/use-idempotency';
import { cn } from '@/lib/utils';
import { useJobStarted } from '../actions/use-job-started';
import { RelativeTime } from '../domain/time';
import { AgentTag } from '../search/recent-searches';
import { EmptyState, ErrorState, Page } from '../states';
import { StatusLabel } from '../status';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { SkeletonRows } from '../ui/skeleton';
import { SwitchField } from '../ui/switch';
import { HistoryExportMenu, downloadJobHistoryCsv, downloadJobHistoryJson } from './history-export';

type HistoryEntry = OperationResponse<'listHistory'>['data'][number];

const ANY = '__any__';

function isFinal(state: string) {
  return TERMINAL_JOB_STATES.includes(state as JobState);
}

function extensionsText(extensions: string[]) {
  if (extensions.length === 0) return null;
  const head = extensions.slice(0, 4).map((e) => `.${e}`).join(' ');
  return extensions.length > 4 ? `${head} +${extensions.length - 4}` : head;
}

function HistoryRow({ entry, job, onDelete }: { entry: HistoryEntry; job: Job | undefined; onDelete: () => void }) {
  const router = useRouter();
  const client = useQueryClient();
  const started = useJobStarted();
  const idempotency = useIdempotency();
  const finished = TERMINAL_JOB_STATES.includes(entry.state as JobState);
  const search = entry.type === 'registry_scan';
  const resume = useMutation({
    mutationFn: async () => (await api.call('resumeJob', { params: { id: entry.jobId } })).data,
    onSuccess: (resumed) => {
      started(resumed, `Resumed ${entry.label ?? jobTypeLabel(entry.type)}`);
      void client.invalidateQueries({ queryKey: qk.history() });
    },
  });
  const retry = useMutation({
    mutationFn: async () => (await api.call('retryJob', { params: { id: entry.jobId }, body: { unresolvedOnly: true }, idempotencyKey: idempotency.keyFor({ retry: entry.jobId }) })).data,
    onSuccess: (created) => {
      idempotency.reset();
      client.setQueryData(qk.job(created.id), created);
      router.push(`/search/${created.id}`);
    },
  });
  const title = entry.label ?? (search ? plural(entry.total, 'check') : jobTypeLabel(entry.type));
  const status = jobStateStatus(entry.state);
  // Finished searches show what they found; only stopped or failed work shows its state.
  const showState = ['interrupted', 'cancelled', 'cancelling'].includes(entry.state);
  return (
    <li className="group/row grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-0.5 rounded-md px-2.5 py-1.5 transition-colors hover:bg-hover sm:grid-cols-[minmax(0,1fr)_minmax(9rem,17rem)_6rem_auto]" data-testid="history-row">
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-2">
          <Link href={`/search/${entry.jobId}`} className="truncate rounded-sm font-medium underline-offset-4 hover:underline">
            {title}
          </Link>
          {entry.origin === 'cli' ? <AgentTag /> : null}
          {!search ? <span className="shrink-0 text-xs text-muted-foreground">{jobTypeLabel(entry.type)}</span> : null}
        </p>
        <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular">{plural(entry.total, search ? 'check' : 'item')}</span>
          {extensionsText(entry.extensions) ? <span className="truncate font-mono">{extensionsText(entry.extensions)}</span> : null}
          {showState ? <StatusLabel status={status} className="sm:hidden" /> : null}
        </p>
      </div>
      <span className="hidden min-w-0 text-sm sm:block">
        {showState ? (
          <StatusLabel status={status} />
        ) : job ? (
          <span className="block truncate tabular">
            {searchSummary(job)}
            {isFinal(job.state) && job.counters.unresolved ? <span className="text-muted-foreground"> · {job.counters.unresolved} unchecked</span> : null}
          </span>
        ) : (
          <span className="text-muted-foreground tabular">{entry.unresolved ? `${entry.unresolved} unchecked` : ''}</span>
        )}
      </span>
      <RelativeTime iso={entry.createdAt} className="hidden text-right text-xs text-muted-foreground sm:block" />
      <div className="row-span-2 flex items-center justify-end gap-1 sm:row-span-1">
        {entry.resumable ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={resume.isPending}
            onClick={() => resume.mutate()}
            aria-description={entry.destinations.length ? `Sends names to ${entry.destinations.join(', ')}` : undefined}
          >
            <Play />
            Resume
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="quiet" aria-label={`More actions for ${title}`}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => router.push(`/search/${entry.jobId}`)}>
              <Search />
              Open results
            </DropdownMenuItem>
            {search ? (
              <DropdownMenuItem onSelect={() => router.push(`/?job=${entry.jobId}`)}>
                <Undo2 />
                Search again with these names
              </DropdownMenuItem>
            ) : null}
            {finished && entry.unresolved > 0 ? (
              <DropdownMenuItem disabled={retry.isPending} onSelect={() => retry.mutate()}>
                <RotateCcw />
                Retry what couldn&apos;t be checked
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
        <p className="col-span-full flex min-w-0 gap-1.5 text-xs text-muted-foreground" data-testid="resume-destinations">
          <Send aria-hidden className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0">
            Resume sends names to <span className="break-all font-mono">{entry.destinations.join(', ')}</span>
          </span>
        </p>
      ) : null}
    </li>
  );
}

/** Recent searches from this UI and from agents; system and watch jobs on request. */
export function HistoryPage() {
  const client = useQueryClient();
  const [q, setQ] = useState('');
  const [everything, setEverything] = useState(false);
  const [type, setType] = useState(ANY);
  const [deleting, setDeleting] = useState<HistoryEntry | null>(null);
  const search = useDebounced(q.trim(), 300);
  const origins = everything ? undefined : PEOPLE_ORIGINS;
  const query = { q: search || undefined, type: everything && type !== ANY ? type : undefined, origins };
  const history = useInfiniteQuery({
    queryKey: qk.history(query),
    queryFn: ({ pageParam, signal }) => api.call('listHistory', { query: { ...query, cursor: pageParam, limit: 50 }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
    refetchInterval: (q) => (q.state.data?.pages.some((p) => p.data.some((e) => e.state === 'running' || e.state === 'queued')) ? 4000 : false),
  });
  const summaries = useJobSummaries(origins);
  const rows = history.data?.pages.flatMap((p) => p.data) ?? [];
  const total = history.data?.pages[0]?.total ?? null;
  const exportable = rows.length > 0 && !history.isPlaceholderData && !history.isFetching;
  const loaded = () => ({ contractVersion: history.data?.pages[0]?.contractVersion ?? '', rows, total, complete: !history.hasNextPage });

  const remove = useMutation({
    mutationFn: async (entry: HistoryEntry) => api.call('deleteJob', { params: { id: entry.jobId } }),
    onSuccess: () => {
      toast.success('Deleted');
      setDeleting(null);
      void client.invalidateQueries({ queryKey: qk.history() });
      void client.invalidateQueries({ queryKey: qk.jobs() });
    },
  });

  return (
    <Page className="items-center">
      <div className="flex w-full max-w-5xl flex-col gap-3 lg:min-h-0 lg:flex-1">
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-2.5">
          <h1 className="flex items-baseline gap-2 text-base font-semibold tracking-tight">
            History
            {total !== null ? <span className="text-sm font-normal text-muted-foreground tabular">{total}</span> : null}
          </h1>
          <div className="ml-auto flex flex-wrap items-center gap-1.5" role="search" aria-label="Filter history">
            <div className="relative w-full sm:w-56">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="search" aria-label="Search history" placeholder="Label or domain" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
            </div>
            {everything ? (
              <Select
                aria-label="Type"
                value={type}
                onValueChange={setType}
                className="w-36"
                options={[{ value: ANY, label: 'All types' }, ...Object.entries(JOB_TYPE).map(([value, label]) => ({ value, label }))]}
              />
            ) : null}
            <SwitchField id="history-everything" label="System and watch jobs" checked={everything} onCheckedChange={setEverything} className="h-control gap-2 px-1.5 text-muted-foreground" />
            <HistoryExportMenu
              label="Export history"
              disabled={!exportable}
              onJson={() => downloadJobHistoryJson({ q: query.q, type: query.type }, loaded())}
              onCsv={() => downloadJobHistoryCsv({ q: query.q, type: query.type }, loaded())}
            />
          </div>
        </header>
        {history.isPending ? (
          <SkeletonRows rows={8} />
        ) : history.isError ? (
          <ErrorState error={history.error} onRetry={() => history.refetch()} />
        ) : rows.length === 0 ? (
          search || everything ? (
            <EmptyState>Nothing matches.</EmptyState>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12">
              <p className="text-sm text-muted-foreground">No searches yet.</p>
              <Button size="sm" variant="primary" asChild>
                <Link href="/">Search</Link>
              </Button>
            </div>
          )
        ) : (
          <div className="relative -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
            <ul className={cn('flex flex-col gap-0.5 transition-opacity', history.isPlaceholderData && 'opacity-60')} aria-label="Searches">
              {rows.map((entry) => (
                <HistoryRow key={entry.jobId} entry={entry} job={summaries.get(entry.jobId)} onDelete={() => setDeleting(entry)} />
              ))}
            </ul>
            {history.hasNextPage ? (
              <div className="flex justify-center py-2">
                <Button variant="ghost" disabled={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.label ?? (deleting ? jobTypeLabel(deleting.type) : 'search')}?`}
        description="The search and its results list are removed. Evidence used by saved lists or other searches is kept."
        confirmLabel="Delete"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </Page>
  );
}
