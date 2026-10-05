'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  BookmarkPlus,
  Camera,
  CircleStop,
  Download,
  Ellipsis,
  Fingerprint,
  Play,
  RotateCcw,
  RotateCw,
  Scale,
  Stethoscope,
  Tag,
  Undo2,
  X,
} from 'lucide-react';
import type { Job, JobItem, ResultFilter } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { JOB_OPERATION, jobStateStatus, jobTypeLabel, outcomeOptions, outcomeStatus } from '@/lib/labels';
import { formatCount, plural } from '@/lib/format';
import { qk, useCollections } from '@/lib/queries';
import { useIdempotency } from '@/lib/use-idempotency';
import { isTerminal, useLiveJob } from '@/lib/use-job';
import { useIsDesktop } from '@/lib/use-media-query';
import { cn, uniq } from '@/lib/utils';
import { ArtifactDialogsHost, type ArtifactRequest } from '../actions/artifact-host';
import { DiagnosticsDialog, NameCheckDialog } from '../actions/enrichment-dialogs';
import { ProviderRequestDialog } from '../actions/provider-request-dialog';
import { ShortlistDialog } from '../actions/shortlist-dialog';
import type { DomainTarget, ScopeInput, ScopeOption } from '../actions/types';
import { useJobStarted } from '../actions/use-job-started';
import { WatchDialog } from '../actions/watch-dialog';
import { MAX_COMPARE_DOMAINS } from '../compare/shared';
import { DomainDetail } from '../domain/domain-detail';
import { RelativeTime } from '../domain/time';
import { EmptyState, ErrorState, PageHeader } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Sheet } from '../ui/sheet';
import { Skeleton, SkeletonRows } from '../ui/skeleton';
import { ResultFilters, filterFromParams, filterToParams, filterToQuery, isFiltered } from './filters';
import { ResultsTable } from './results-table';
import { useSelection } from './selection';

const PAGE_SIZE = 200;
const RESOLVE_PAGE_SIZE = 1000;
const MAX_BULK_DOMAINS = 10_000;

type DialogName = 'shortlist' | 'providers' | 'names' | 'diagnostics' | 'watch' | null;

function Progress({ job, activeOutcomes, onOutcome }: { job: Job; activeOutcomes: string[]; onOutcome: (outcome: string) => void }) {
  const { counters } = job;
  const percent = counters.total ? Math.round((counters.finished / counters.total) * 1000) / 10 : 0;
  const operation = JOB_OPERATION[job.type];
  const outcomes = Object.entries(counters.outcomes).filter(([, count]) => count > 0);
  return (
    <section aria-label="Progress" className="mb-8 flex flex-col gap-4">
      <div
        role="progressbar"
        aria-label="Completed"
        aria-valuemin={0}
        aria-valuemax={counters.total}
        aria-valuenow={counters.finished}
        className="h-1.5 w-full overflow-hidden rounded-full bg-input"
      >
        <div className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
      </div>
      <dl className="flex flex-wrap gap-x-8 gap-y-3" data-testid="job-counters">
        {(
          [
            ['Completed', `${formatCount(counters.finished)} / ${formatCount(counters.total)}`],
            ['Pending', formatCount(counters.pending + counters.running)],
            ['Unresolved', formatCount(counters.unresolved)],
            ...(counters.interrupted ? [['Interrupted', formatCount(counters.interrupted)] as const] : []),
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-mono text-lg tabular">{value}</dd>
          </div>
        ))}
      </dl>
      {outcomes.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by outcome">
          {outcomes.map(([outcome, count]) => {
            const active = activeOutcomes.includes(outcome);
            return (
              <button
                key={outcome}
                type="button"
                aria-pressed={active}
                onClick={() => onOutcome(outcome)}
                className={cn('inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-sm transition-colors', active ? 'bg-selected font-medium' : 'hover:bg-hover')}
              >
                <StatusLabel status={outcomeStatus(operation, outcome)} />
                <span className="font-mono text-xs text-muted-foreground tabular">{formatCount(count)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {job.nextRetryAt ? (
        <p className="text-sm text-muted-foreground">
          Some sources are cooling down. Next retry <RelativeTime iso={job.nextRetryAt} />.
        </p>
      ) : null}
    </section>
  );
}

function Destinations({ destinations }: { destinations: string[] }) {
  const [open, setOpen] = useState(false);
  if (destinations.length === 0) return null;
  const shown = open ? destinations : destinations.slice(0, 3);
  return (
    <p className="text-sm text-muted-foreground">
      Destinations: <span className="font-mono text-[13px] text-foreground">{shown.join(', ')}</span>
      {destinations.length > 3 ? (
        <button type="button" className="ml-2 rounded-sm underline underline-offset-4" onClick={() => setOpen((v) => !v)}>
          {open ? 'Less' : `${destinations.length - 3} more`}
        </button>
      ) : null}
    </p>
  );
}

export function JobView({ jobId }: { jobId: string }) {
  const router = useRouter();
  const client = useQueryClient();
  const searchParams = useSearchParams();
  const isDesktop = useIsDesktop();
  const started = useJobStarted();
  const retryIdempotency = useIdempotency();
  const searchRef = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [artifact, setArtifact] = useState<ArtifactRequest | null>(null);

  const job = useLiveJob(jobId);
  const filter = useMemo(() => filterFromParams(new URLSearchParams(searchParams.toString())), [searchParams]);
  const filterKey = JSON.stringify(filter);
  const detailName = searchParams.get('d');
  const running = job.data ? !isTerminal(job.data) : false;
  const operation = job.data ? JOB_OPERATION[job.data.type] : 'registry';
  const domainJob = job.data?.type !== 'name_check';

  const setUrl = useCallback(
    (params: URLSearchParams) => {
      const query = params.toString();
      window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
    },
    [],
  );
  const updateFilter = useCallback(
    (patch: Partial<ResultFilter>) => {
      const current = filterFromParams(new URLSearchParams(window.location.search));
      const next = filterToParams({ ...current, ...patch }, new URLSearchParams(window.location.search));
      if (next.toString() !== new URLSearchParams(window.location.search).toString()) setUrl(next);
    },
    [setUrl],
  );

  const results = useInfiniteQuery({
    queryKey: qk.jobResults(jobId, filter),
    queryFn: ({ pageParam, signal }) =>
      api.call('listJobResults', { params: { id: jobId }, query: { ...filterToQuery(filter), cursor: pageParam, limit: PAGE_SIZE }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
    refetchInterval: !job.live && running ? 5000 : false,
  });
  const rows = useMemo(() => results.data?.pages.flatMap((page) => page.data) ?? [], [results.data]);

  // Whether the stream or polling saw it, a job reaching a terminal state gets one final results refetch.
  const jobState = job.data?.state;
  const previousJobState = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!jobState) return;
    const previous = previousJobState.current;
    previousJobState.current = jobState;
    if (!isTerminal({ state: jobState })) return;
    if (previous && previous !== jobState) {
      void client.invalidateQueries({ queryKey: qk.jobResults(jobId) });
    } else if (!previous) {
      // First sighting is already terminal: refetch only if the rows were loaded before it.
      const jobUpdated = client.getQueryState(qk.job(jobId))?.dataUpdatedAt ?? 0;
      const stale = client
        .getQueryCache()
        .findAll({ queryKey: qk.jobResults(jobId) })
        .some((query) => query.state.dataUpdatedAt > 0 && query.state.dataUpdatedAt < jobUpdated);
      if (stale) void client.invalidateQueries({ queryKey: qk.jobResults(jobId) });
    }
  }, [client, jobId, jobState]);
  const total = results.data?.pages[0]?.total ?? null;

  const selection = useSelection(filterKey);
  const selectedCount = selection.count(total);
  const collections = useCollections();

  // "/" focuses the result search when not typing elsewhere.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /** All matching items for the current selection, paging through the filter in all-matching mode. */
  const resolveItems = useCallback(async (): Promise<JobItem[]> => {
    if (selection.mode === 'ids') return selection.explicitItems;
    const items: JobItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.call('listJobResults', {
        params: { id: jobId },
        query: { ...filterToQuery(filter), cursor, limit: RESOLVE_PAGE_SIZE },
      });
      for (const item of page.data) if (!selection.excluded.has(item.id)) items.push(item);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  }, [selection, jobId, filter]);

  const target: DomainTarget = {
    count: selectedCount,
    resolveDomains: async () => {
      const domains = uniq((await resolveItems()).map((item) => item.subject));
      if (domains.length > MAX_BULK_DOMAINS) throw new Error(`Select at most ${formatCount(MAX_BULK_DOMAINS)} domains for this action.`);
      return domains;
    },
  };

  const recheck = useMutation({
    mutationFn: async () => {
      const body = { domains: await target.resolveDomains() };
      if (body.domains.length === 0) throw new Error('Nothing selected.');
      return (await api.call('createRecheck', { body, idempotencyKey: retryIdempotency.keyFor({ recheck: body }) })).data;
    },
    onSuccess: (created) => {
      retryIdempotency.reset();
      started(created, `Recheck of ${plural(created.counters.total, 'domain')} started`);
    },
  });

  // Comparisons read retained offers only, so opening one sends nothing anywhere.
  const compare = useMutation({
    mutationFn: async () => {
      const domains = await target.resolveDomains();
      if (domains.length === 0) throw new Error('Nothing selected.');
      if (domains.length > MAX_COMPARE_DOMAINS) throw new Error(`Compare at most ${MAX_COMPARE_DOMAINS} domains at a time.`);
      return domains;
    },
    onSuccess: (domains) => router.push(`/compare?domains=${encodeURIComponent(domains.join(','))}`),
  });

  const cancel = useMutation({
    mutationFn: async () => (await api.call('cancelJob', { params: { id: jobId } })).data,
    onSuccess: (data) => client.setQueryData(qk.job(jobId), data),
  });
  const resume = useMutation({
    mutationFn: async () => (await api.call('resumeJob', { params: { id: jobId } })).data,
    onSuccess: (data) => client.setQueryData(qk.job(jobId), data),
  });
  const retry = useMutation({
    mutationFn: async () => {
      const body = { unresolvedOnly: true };
      return (await api.call('retryJob', { params: { id: jobId }, body, idempotencyKey: retryIdempotency.keyFor({ retry: jobId }) })).data;
    },
    onSuccess: (created) => {
      retryIdempotency.reset();
      client.setQueryData(qk.job(created.id), created);
      router.push(`/jobs/${created.id}`);
    },
  });

  const exportScopes: ScopeOption[] = [
    {
      value: 'selection',
      label: `Selected rows (${formatCount(selectedCount)})`,
      disabled: selectedCount === 0,
      build: async (): Promise<ScopeInput> => {
        if (selection.mode === 'all' && selection.excluded.size === 0) return { kind: 'filter', jobId, filter };
        const ids = (await resolveItems()).map((item) => item.id);
        if (ids.length === 0) throw new Error('Nothing selected.');
        return { kind: 'selection', itemIds: ids };
      },
    },
    {
      value: 'filter',
      label: isFiltered(filter) ? `Current filter (${total === null ? 'all matching' : formatCount(total)})` : `Current view (${total === null ? 'all' : formatCount(total)})`,
      build: async () => ({ kind: 'filter', jobId, filter }),
    },
    { value: 'job', label: `Whole job (${formatCount(job.data?.counters.total ?? 0)})`, build: async () => ({ kind: 'job', jobId }) },
  ];

  const openItem = useCallback(
    (item: JobItem) => {
      if (!isDesktop) {
        router.push(`/domains/${encodeURIComponent(item.subject)}`);
        return;
      }
      const params = new URLSearchParams(window.location.search);
      params.set('d', item.subject);
      setUrl(params);
    },
    [isDesktop, router, setUrl],
  );
  const canOpen = useCallback((item: JobItem) => item.operation !== 'name_check', []);
  const closeDetail = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete('d');
    setUrl(params);
  };

  if (job.isPending) {
    return (
      <>
        <Skeleton className="mb-6 h-7 w-56" />
        <Skeleton className="mb-8 h-1.5 w-full" />
        <SkeletonRows rows={10} />
      </>
    );
  }
  if (job.isError) {
    return (
      <>
        <PageHeader title="Job" />
        <ErrorState error={job.error} onRetry={() => job.refetch()} />
      </>
    );
  }

  const data = job.data;
  const state = jobStateStatus(data.state);
  const canCancel = data.state === 'queued' || data.state === 'running';
  const canResume = (data.state === 'interrupted' || data.state === 'cancelled') && data.counters.pending + data.counters.interrupted > 0;
  const canRetry = isTerminal(data) && data.counters.unresolved > 0;
  const outcomeChoices = uniq([...outcomeOptions(operation).map((o) => o.value), ...Object.keys(data.counters.outcomes)]).map((value) => ({
    value,
    label: outcomeStatus(operation, value).label,
  }));
  const suffixChoices = uniq([...data.input.extensions, ...rows.map((r) => r.suffix).filter((s): s is string => Boolean(s))])
    .sort()
    .map((s) => ({ value: s, label: `.${s}` }));
  const activeItem = detailName ? rows.find((r) => r.subject === detailName) : undefined;
  const panelOpen = Boolean(detailName) && isDesktop;
  // Icon-only on small screens and beside the detail panel; labels stay available to screen readers.
  const toolbarLabel = panelOpen ? 'sr-only' : 'max-sm:sr-only';
  const toolbarButton = panelOpen ? 'px-2' : 'max-sm:px-2';
  const allLoadedSelected = rows.length > 0 && rows.every((r) => selection.isSelected(r.id));

  return (
    <>
      <Link href="/jobs" className="mb-3 inline-block rounded-sm text-sm text-muted-foreground hover:text-foreground">
        Jobs
      </Link>
      <PageHeader
        title={data.label ?? jobTypeLabel(data.type)}
        actions={
          <>
            {canCancel ? (
              <Button size="sm" variant="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                <CircleStop />
                Cancel
              </Button>
            ) : null}
            {canResume ? (
              <Button size="sm" variant="primary" disabled={resume.isPending} onClick={() => resume.mutate()}>
                <Play />
                Resume
              </Button>
            ) : null}
            {canRetry ? (
              <Button size="sm" variant="secondary" disabled={retry.isPending} onClick={() => retry.mutate()}>
                <RotateCcw />
                Retry unresolved
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => setArtifact({ kind: 'export', defaultScope: 'filter' })}>
              <Download />
              Export
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="secondary" aria-label="More job actions">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setArtifact({ kind: 'snapshot', defaultScope: 'filter' })}>
                  <Camera />
                  Snapshot
                </DropdownMenuItem>
                {data.type === 'registry_scan' ? (
                  <DropdownMenuItem onSelect={() => router.push(`/scan?job=${data.id}`)}>
                    <Undo2 />
                    Edit input as new scan
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <StatusLabel status={state} className="font-medium" />
          <span className="text-muted-foreground">
            {jobTypeLabel(data.type)} · created <RelativeTime iso={data.createdAt} />
            {data.finishedAt ? (
              <>
                {' '}
                · finished <RelativeTime iso={data.finishedAt} />
              </>
            ) : null}
          </span>
          {data.input.extensions.length ? (
            <span className="font-mono text-[13px] text-muted-foreground">{data.input.extensions.map((e) => `.${e}`).join(' ')}</span>
          ) : null}
        </div>
        <Destinations destinations={data.destinations} />
      </PageHeader>

      <Progress
        job={data}
        activeOutcomes={filter.outcomes ?? []}
        onOutcome={(outcome) => {
          const current = new Set(filter.outcomes ?? []);
          if (current.has(outcome)) current.delete(outcome);
          else current.add(outcome);
          updateFilter({ outcomes: current.size ? [...current] : undefined });
        }}
      />

      <ResultFilters
        filter={filter}
        onChange={updateFilter}
        outcomeOptions={outcomeChoices}
        suffixOptions={suffixChoices}
        collections={(collections.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
        searchRef={searchRef}
      />

      <div className="mb-2 mt-5 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground" aria-live="polite">
        <span>{total === null ? plural(rows.length, 'result') : plural(total, 'result')}</span>
        {selectedCount > 0 && selection.mode === 'ids' && allLoadedSelected && !results.isPlaceholderData && total !== null && total > rows.length ? (
          <Button size="sm" variant="link" className="text-foreground" onClick={selection.selectAllMatching}>
            Select all {formatCount(total)} matching
          </Button>
        ) : null}
        {selection.mode === 'all' && selectedCount > 0 ? <span className="text-foreground">All matching results selected</span> : null}
      </div>

      {results.isError ? (
        <ErrorState error={results.error} onRetry={() => results.refetch()} />
      ) : results.isPending ? (
        <SkeletonRows rows={10} />
      ) : rows.length === 0 ? (
        <EmptyState>{isFiltered(filter) ? 'No results match these filters.' : running ? 'Results appear as checks finish.' : 'No results.'}</EmptyState>
      ) : (
        <div
          className={cn('transition-opacity', results.isPlaceholderData && 'opacity-60')}
          // Rows from the previous filter stay visible while the new one loads, but cannot be acted on.
          inert={results.isPlaceholderData}
          aria-busy={results.isPlaceholderData}
        >
          <ResultsTable
            rows={rows}
            total={total}
            hasNextPage={results.hasNextPage}
            fetchNextPage={() => void results.fetchNextPage()}
            isFetchingNextPage={results.isFetchingNextPage}
            selection={selection}
            activeId={activeItem?.id ?? null}
            showTarget={operation !== 'registry' || data.type === 'watch'}
            canOpen={canOpen}
            onOpen={openItem}
          />
        </div>
      )}

      {selectedCount > 0 ? (
        <div
          role="toolbar"
          aria-label="Selected results"
          className={cn(
            'fixed bottom-4 z-50 flex max-w-[calc(100vw-1.5rem)] flex-nowrap items-center gap-0.5 rounded-xl bg-popover p-1.5 shadow-[0_8px_40px_rgb(0_0_0/0.18)] dark:shadow-[0_8px_40px_rgb(0_0_0/0.7)]',
            // Centered over the main column; beside the detail panel when it is open.
            panelOpen ? 'left-[calc(var(--sidebar-width)+1rem)]' : 'left-1/2 -translate-x-1/2 md:left-[calc(50%+var(--sidebar-width)/2)]',
          )}
        >
          <span className="whitespace-nowrap px-2.5 text-sm font-medium tabular">{formatCount(selectedCount)} selected</span>
          {domainJob ? (
            <>
              <Button size="sm" variant="ghost" className={toolbarButton} aria-label={panelOpen ? 'Shortlist' : undefined} onClick={() => setDialog('shortlist')}>
                <BookmarkPlus />
                <span className={toolbarLabel}>Shortlist</span>
              </Button>
              <Button size="sm" variant="ghost" className={toolbarButton} aria-label={panelOpen ? 'Recheck' : undefined} disabled={recheck.isPending} onClick={() => recheck.mutate()}>
                <RotateCw />
                <span className={toolbarLabel}>Recheck</span>
              </Button>
              <Button size="sm" variant="ghost" className={toolbarButton} aria-label={panelOpen ? 'Quotes' : undefined} onClick={() => setDialog('providers')}>
                <Tag />
                <span className={toolbarLabel}>Quotes</span>
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className={toolbarButton}
            aria-label={panelOpen ? 'Export' : undefined}
            onClick={() => setArtifact({ kind: 'export', defaultScope: 'selection' })}
          >
            <Download />
            <span className={toolbarLabel}>Export</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className={toolbarButton} aria-label="More actions for selected results">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top">
              {domainJob ? (
                <>
                  <DropdownMenuItem onSelect={() => setDialog('names')}>
                    <Fingerprint />
                    Name checks
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialog('diagnostics')}>
                    <Stethoscope />
                    Diagnostics
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialog('watch')}>
                    <Bell />
                    Watch
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={compare.isPending} onSelect={() => compare.mutate()}>
                    <Scale />
                    Compare prices
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuItem onSelect={() => setArtifact({ kind: 'snapshot', defaultScope: 'selection' })}>
                <Camera />
                Snapshot
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="icon-sm" variant="quiet" aria-label="Clear selection" onClick={selection.clear}>
            <X />
          </Button>
        </div>
      ) : null}

      <Sheet open={panelOpen} onOpenChange={(open) => !open && closeDetail()} title={detailName ?? ''}>
        {detailName ? <DomainDetail key={detailName} name={detailName} variant="panel" /> : null}
      </Sheet>

      <ShortlistDialog open={dialog === 'shortlist'} onOpenChange={(o) => setDialog(o ? 'shortlist' : null)} target={target} />
      <ProviderRequestDialog open={dialog === 'providers'} onOpenChange={(o) => setDialog(o ? 'providers' : null)} target={target} />
      <NameCheckDialog open={dialog === 'names'} onOpenChange={(o) => setDialog(o ? 'names' : null)} target={target} />
      <DiagnosticsDialog open={dialog === 'diagnostics'} onOpenChange={(o) => setDialog(o ? 'diagnostics' : null)} target={target} />
      <WatchDialog open={dialog === 'watch'} onOpenChange={(o) => setDialog(o ? 'watch' : null)} target={target} />
      <ArtifactDialogsHost request={artifact} onClose={() => setArtifact(null)} scopes={exportScopes} />
    </>
  );
}
