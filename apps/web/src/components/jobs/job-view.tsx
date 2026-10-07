'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Bell,
  BookmarkPlus,
  Camera,
  ChevronDown,
  CircleStop,
  Download,
  Ellipsis,
  Fingerprint,
  Play,
  RotateCcw,
  RotateCw,
  Save,
  Stethoscope,
  Tag,
  X,
} from 'lucide-react';
import type { Job, JobItem, ResultFilter } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { providersFromParams, withoutPrice } from '@/lib/criteria';
import { JOB_OPERATION, jobStateStatus, jobTypeLabel, outcomeOptions, outcomeStatus } from '@/lib/labels';
import { formatCount, plural } from '@/lib/format';
import { qk, useCollections } from '@/lib/queries';
import { useIdempotency } from '@/lib/use-idempotency';
import { isTerminal, useLiveJob } from '@/lib/use-job';
import { useIsWide } from '@/lib/use-media-query';
import { cn, uniq } from '@/lib/utils';
import { ArtifactDialogsHost, type ArtifactRequest } from '../actions/artifact-host';
import { DiagnosticsDialog, NameCheckDialog } from '../actions/enrichment-dialogs';
import { ProviderRequestDialog } from '../actions/provider-request-dialog';
import { SaveCriteriaDialog } from '../actions/save-criteria';
import { ShortlistDialog } from '../actions/shortlist-dialog';
import type { DomainTarget, ScopeInput, ScopeOption } from '../actions/types';
import { useJobStarted } from '../actions/use-job-started';
import { WatchDialog } from '../actions/watch-dialog';
import { DomainDock } from '../domain/domain-panel';
import { RelativeTime } from '../domain/time';
import { Crumb, EmptyState, ErrorState, Page, PageHeader } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Skeleton, SkeletonRows } from '../ui/skeleton';
import { ResultFilters, describeFilter, filterFromParams, filterToParams, filterToQuery, isFiltered } from './filters';
import { ResultsTable } from './results-table';
import { useSelection } from './selection';

const PAGE_SIZE = 200;
const RESOLVE_PAGE_SIZE = 1000;
const MAX_BULK_DOMAINS = 10_000;

type DialogName = 'shortlist' | 'providers' | 'names' | 'diagnostics' | 'watch' | 'criteria' | null;

/** Outcome counts that double as filter toggles; they sit inline in the page header. */
function OutcomeChips({ job, activeOutcomes, onOutcome }: { job: Job; activeOutcomes: string[]; onOutcome: (outcome: string) => void }) {
  const operation = JOB_OPERATION[job.type];
  const outcomes = Object.entries(job.counters.outcomes).filter(([, count]) => count > 0);
  if (outcomes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-0.5 text-sm text-foreground" role="group" aria-label="Filter by outcome">
      {outcomes.map(([outcome, count]) => {
        const active = activeOutcomes.includes(outcome);
        return (
          <button
            key={outcome}
            type="button"
            aria-pressed={active}
            onClick={() => onOutcome(outcome)}
            className={cn(
              'inline-flex h-control items-center gap-1.5 rounded-md px-2 transition-colors',
              active ? 'bg-selected font-medium' : 'hover:bg-hover',
            )}
          >
            <StatusLabel status={outcomeStatus(operation, outcome)} />
            <span className="font-mono text-xs text-muted-foreground tabular">{formatCount(count)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Thin progress line under the header, only while the job runs. */
function ProgressLine({ job }: { job: Job }) {
  const { counters } = job;
  const percent = counters.total ? Math.round((counters.finished / counters.total) * 1000) / 10 : 0;
  return (
    <div
      role="progressbar"
      aria-label="Completed"
      aria-valuemin={0}
      aria-valuemax={counters.total}
      aria-valuenow={counters.finished}
      className="-mt-2 h-0.5 w-full shrink-0 overflow-hidden rounded-full bg-input"
    >
      <div className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** "3 destinations" that opens the list of hosts this job sends names to. */
function Destinations({ destinations }: { destinations: string[] }) {
  if (destinations.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex h-6 items-center gap-1 rounded-sm underline-offset-4 hover:text-foreground hover:underline">
          {plural(destinations.length, 'destination')}
          <ChevronDown aria-hidden className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[min(32rem,calc(100vw-2rem))]">
        <ul aria-label="Destinations" className="flex flex-col gap-1 font-mono text-xs">
          {destinations.map((destination) => (
            <li key={destination} className="break-all">
              {destination}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function JobView({ jobId }: { jobId: string }) {
  const router = useRouter();
  const client = useQueryClient();
  const searchParams = useSearchParams();
  const isWide = useIsWide();
  const started = useJobStarted();
  const retryIdempotency = useIdempotency();
  const searchRef = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [artifact, setArtifact] = useState<ArtifactRequest | null>(null);

  const job = useLiveJob(jobId);
  const filter = useMemo(() => filterFromParams(new URLSearchParams(searchParams.toString())), [searchParams]);
  const filterKey = JSON.stringify(filter);
  // Providers chosen with restored criteria; they preselect provider requests and saved criteria.
  const selectedProviders = useMemo(() => providersFromParams(new URLSearchParams(searchParams.toString())), [searchParams]);
  const detailName = searchParams.get('d');
  const running = job.data ? !isTerminal(job.data) : false;
  const operation = job.data ? JOB_OPERATION[job.data.type] : 'registry';
  // Name checks are about names and catalog refreshes about providers; neither has domain subjects.
  const domainJob = job.data?.type !== 'name_check' && job.data?.type !== 'catalog_refresh';

  const setUrl = useCallback((params: URLSearchParams) => {
    const query = params.toString();
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
  }, []);
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
      api.call('listJobResults', {
        params: { id: jobId },
        query: { ...filterToQuery(filter), cursor: pageParam, limit: PAGE_SIZE },
        signal,
      }),
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
      return (
        await api.call('createRecheck', {
          body,
          idempotencyKey: retryIdempotency.keyFor({ recheck: body }),
        })
      ).data;
    },
    onSuccess: (created) => {
      retryIdempotency.reset();
      started(created, `Recheck of ${plural(created.counters.total, 'domain')} started`);
    },
  });

  // Saving stores the filter as shown plus chosen providers and budget; nothing runs. The price cap
  // is saved as the budget (prefilled from it), so clearing the budget removes the cap.
  const saveCriteria = useMutation({
    mutationFn: async (choice: { name: string; providerIds: string[]; budget: { amount: string; currency: string } | null }) => {
      const input = job.data?.input;
      const body = {
        name: choice.name,
        filter: withoutPrice(filter),
        extensions: input?.extensions ?? [],
        providerIds: choice.providerIds,
        budget: choice.budget,
        input: job.data?.type === 'registry_scan' ? (input?.text ?? null) : null,
      };
      return (await api.call('createCriteria', { body })).data;
    },
    onSuccess: (criteria) => {
      void client.invalidateQueries({ queryKey: qk.criteria });
      toast.success(`Saved ${criteria.name}`, {
        action: { label: 'Saved', onClick: () => router.push('/saved') },
      });
    },
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
      return (
        await api.call('retryJob', {
          params: { id: jobId },
          body,
          idempotencyKey: retryIdempotency.keyFor({ retry: jobId }),
        })
      ).data;
    },
    onSuccess: (created) => {
      retryIdempotency.reset();
      client.setQueryData(qk.job(created.id), created);
      router.push(`/search/${created.id}`);
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
      label: isFiltered(filter)
        ? `Current filter (${total === null ? 'all matching' : formatCount(total)})`
        : `Current view (${total === null ? 'all' : formatCount(total)})`,
      build: async () => ({ kind: 'filter', jobId, filter }),
    },
    {
      value: 'job',
      label: `Whole job (${formatCount(job.data?.counters.total ?? 0)})`,
      build: async () => ({ kind: 'job', jobId }),
    },
  ];

  const openItem = useCallback(
    (item: JobItem) => {
      if (!isWide) {
        router.push(`/domains/${encodeURIComponent(item.subject)}`);
        return;
      }
      const params = new URLSearchParams(window.location.search);
      params.set('d', item.subject);
      setUrl(params);
    },
    [isWide, router, setUrl],
  );
  const canOpen = useCallback((item: JobItem) => item.operation !== 'name_check' && item.operation !== 'catalog', []);
  const closeDetail = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete('d');
    setUrl(params);
  }, [setUrl]);

  if (job.isPending) {
    return (
      <Page>
        <Skeleton className="h-control w-72" />
        <Skeleton className="h-control w-full" />
        <SkeletonRows rows={12} />
      </Page>
    );
  }
  if (job.isError) {
    return (
      <Page>
        <PageHeader title="Job" leading={<JobsCrumb />} />
        <ErrorState error={job.error} onRetry={() => job.refetch()} />
      </Page>
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
  const panelOpen = Boolean(detailName) && isWide;
  const allLoadedSelected = rows.length > 0 && rows.every((r) => selection.isSelected(r.id));
  const toggleOutcome = (outcome: string) => {
    const current = new Set(filter.outcomes ?? []);
    if (current.has(outcome)) current.delete(outcome);
    else current.add(outcome);
    updateFilter({ outcomes: current.size ? [...current] : undefined });
  };
  const unresolvedOnly = filter.resolved === false;
  const { counters } = data;

  return (
    <div className="flex min-w-0 flex-1 lg:min-h-0">
      <Page>
        <PageHeader
          leading={<JobsCrumb />}
          title={data.label ?? jobTypeLabel(data.type)}
          meta={<StatusLabel status={state} className="font-medium" />}
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
                  <DropdownMenuItem onSelect={() => setDialog('criteria')}>
                    <Save />
                    Save criteria
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        >
          {/* Key numbers and the outcome breakdown at body size; type, times and destinations muted after them. */}
          <dl className="flex items-center gap-x-3 text-sm text-muted-foreground" data-testid="job-counters">
            <div className="flex items-baseline gap-1">
              <dt className="sr-only">Completed</dt>
              <dd className="font-mono text-foreground tabular">
                {formatCount(counters.finished)}/{formatCount(counters.total)}
              </dd>
            </div>
            {counters.pending + counters.running > 0 ? (
              <div className="flex items-baseline gap-1">
                <dd className="font-mono tabular">{formatCount(counters.pending + counters.running)}</dd>
                <dt>pending</dt>
              </div>
            ) : null}
            {counters.interrupted ? (
              <div className="flex items-baseline gap-1">
                <dd className="font-mono tabular">{formatCount(counters.interrupted)}</dd>
                <dt>interrupted</dt>
              </div>
            ) : null}
            <div className="flex items-baseline gap-1">
              {counters.unresolved > 0 ? (
                <button
                  type="button"
                  aria-pressed={unresolvedOnly}
                  onClick={() => updateFilter({ resolved: unresolvedOnly ? undefined : false })}
                  className={cn(
                    '-mx-1 inline-flex h-control items-baseline gap-1 rounded-md px-1 leading-8 transition-colors',
                    unresolvedOnly ? 'bg-selected text-foreground' : 'hover:bg-hover hover:text-foreground',
                  )}
                >
                  <dd className="font-mono tabular">{formatCount(counters.unresolved)}</dd>
                  <dt>unresolved</dt>
                </button>
              ) : (
                <>
                  <dd className="font-mono tabular">0</dd>
                  <dt>unresolved</dt>
                </>
              )}
            </div>
          </dl>
          <OutcomeChips job={data} activeOutcomes={filter.outcomes ?? []} onOutcome={toggleOutcome} />
          <span>
            {jobTypeLabel(data.type)} · created <RelativeTime iso={data.createdAt} />
            {data.finishedAt ? (
              <>
                {' '}
                · finished <RelativeTime iso={data.finishedAt} />
              </>
            ) : null}
          </span>
          {data.input.extensions.length ? <span className="font-mono">{data.input.extensions.map((e) => `.${e}`).join(' ')}</span> : null}
          <Destinations destinations={data.destinations} />
          {data.nextRetryAt ? (
            <span>
              Some sources are cooling down. Next retry <RelativeTime iso={data.nextRetryAt} />.
            </span>
          ) : null}
        </PageHeader>
        {running ? <ProgressLine job={data} /> : null}

        <ResultFilters
          filter={filter}
          onChange={updateFilter}
          outcomeOptions={outcomeChoices}
          suffixOptions={suffixChoices}
          showConfirmations={domainJob}
          collections={(collections.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          searchRef={searchRef}
          count={total === null ? plural(rows.length, 'result') : plural(total, 'result')}
        />

        {/* Below lg the page scrolls; the table keeps a window-tall pane of its own. */}
        <div className="@container/pane relative flex min-h-0 flex-1 flex-col max-lg:h-[calc(100dvh-4rem)] max-lg:flex-none">
          {results.isError ? (
            <ErrorState error={results.error} onRetry={() => results.refetch()} />
          ) : results.isPending ? (
            <SkeletonRows rows={12} />
          ) : rows.length === 0 ? (
            <EmptyState>{isFiltered(filter) ? 'No results match these filters.' : running ? 'Results appear as checks finish.' : 'No results.'}</EmptyState>
          ) : (
            <div
              className={cn('flex min-h-0 flex-1 flex-col transition-opacity', results.isPlaceholderData && 'opacity-60')}
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
                bottomInset={selectedCount > 0 ? 64 : 0}
              />
            </div>
          )}

          {selectedCount > 0 ? (
            <div
              role="toolbar"
              aria-label="Selected results"
              className={cn(
                'z-30 flex max-w-[calc(100%-1rem)] flex-nowrap items-center gap-0.5 overflow-x-auto rounded-xl bg-popover p-1.5 shadow-[0_8px_40px_rgb(0_0_0/0.18)] dark:shadow-[0_8px_40px_rgb(0_0_0/0.7)]',
                // Floats over the bottom of the table pane, centered on it, so it never covers the docked panel.
                'absolute bottom-3 left-1/2 -translate-x-1/2 max-lg:fixed max-lg:bottom-4 max-lg:max-w-[calc(100vw-1.5rem)] md:max-lg:left-[calc(50%+var(--sidebar-width)/2)]',
              )}
            >
              <span className="whitespace-nowrap px-2 text-sm font-medium tabular">{formatCount(selectedCount)} selected</span>
              {selection.mode === 'ids' && allLoadedSelected && !results.isPlaceholderData && total !== null && total > rows.length ? (
                <Button size="sm" variant="link" className="px-1.5 text-muted-foreground" onClick={selection.selectAllMatching}>
                  Select all {formatCount(total)} matching
                </Button>
              ) : null}
              {selection.mode === 'all' ? <span className="whitespace-nowrap px-1.5 text-xs text-muted-foreground">All matching</span> : null}
              {domainJob ? (
                <>
                  <ToolbarButton label="Save" onClick={() => setDialog('shortlist')}>
                    <BookmarkPlus />
                  </ToolbarButton>
                  <ToolbarButton label="Recheck" disabled={recheck.isPending} onClick={() => recheck.mutate()}>
                    <RotateCw />
                  </ToolbarButton>
                  <ToolbarButton label="Quotes" onClick={() => setDialog('providers')}>
                    <Tag />
                  </ToolbarButton>
                </>
              ) : null}
              <ToolbarButton label="Export" onClick={() => setArtifact({ kind: 'export', defaultScope: 'selection' })}>
                <Download />
              </ToolbarButton>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label="More actions for selected results">
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
        </div>
      </Page>

      {panelOpen && detailName ? <DomainDock name={detailName} onClose={closeDetail} /> : null}

      <ShortlistDialog open={dialog === 'shortlist'} onOpenChange={(o) => setDialog(o ? 'shortlist' : null)} target={target} />
      <ProviderRequestDialog
        open={dialog === 'providers'}
        onOpenChange={(o) => setDialog(o ? 'providers' : null)}
        target={target}
        defaultSelected={selectedProviders}
      />
      <NameCheckDialog open={dialog === 'names'} onOpenChange={(o) => setDialog(o ? 'names' : null)} target={target} />
      <DiagnosticsDialog open={dialog === 'diagnostics'} onOpenChange={(o) => setDialog(o ? 'diagnostics' : null)} target={target} />
      <WatchDialog open={dialog === 'watch'} onOpenChange={(o) => setDialog(o ? 'watch' : null)} target={target} />
      <ArtifactDialogsHost request={artifact} onClose={() => setArtifact(null)} scopes={exportScopes} />
      <SaveCriteriaDialog
        open={dialog === 'criteria'}
        onOpenChange={(o) => setDialog(o ? 'criteria' : null)}
        summary={
          <>
            <p>{describeFilter(withoutPrice(filter), operation).join(' · ') || 'No filter'}</p>
            {data.input.extensions.length ? <p className="font-mono text-[13px]">{data.input.extensions.map((e) => `.${e}`).join(' ')}</p> : null}
          </>
        }
        initialProviders={selectedProviders}
        initialBudget={{ amount: filter.maxPrice ?? '', currency: filter.priceCurrency ?? null }}
        pending={saveCriteria.isPending}
        onSave={(choice) => saveCriteria.mutateAsync(choice)}
      />
    </div>
  );
}

function JobsCrumb() {
  return (
    <Crumb>
      <Link href="/history" className="rounded-sm hover:text-foreground">
        History
      </Link>
    </Crumb>
  );
}

/** Icon plus label; the label hides when the table pane is narrow (a docked panel is open) and stays the accessible name. */
function ToolbarButton({ label, children, ...props }: { label: string; children: React.ReactNode } & Omit<React.ComponentProps<typeof Button>, 'children'>) {
  return (
    <Button size="sm" variant="ghost" className="px-2 @2xl/pane:px-2.5" {...props}>
      {children}
      <span className="sr-only @2xl/pane:not-sr-only">{label}</span>
    </Button>
  );
}
