'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bookmark, Camera, ChevronDown, CircleStop, Download, Ellipsis, Eye, Fingerprint, LayoutGrid, List, Play, RotateCw, Save, Stethoscope, Tag, Trash, X } from 'lucide-react';
import { toast } from 'sonner';
import type { Job, JobItem } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { providersFromParams } from '@/lib/criteria';
import { formatCount, plural } from '@/lib/format';
import { useHorizon, usePriceCurrency, useProviderNames, useSuffixPrices } from '@/lib/prices';
import { qk, useCollections } from '@/lib/queries';
import { defaultListOf, useQuickSave, useQuickWatch, useWatchIndex } from '@/lib/saved';
import { isTerminal, useLiveJob } from '@/lib/use-job';
import { useIsWide } from '@/lib/use-media-query';
import { cn, uniq } from '@/lib/utils';
import { ArtifactDialogsHost, type ArtifactRequest } from '../actions/artifact-host';
import { DiagnosticsDialog, NameCheckDialog } from '../actions/enrichment-dialogs';
import { ProviderRequestDialog } from '../actions/provider-request-dialog';
import { SaveCriteriaDialog } from '../actions/save-criteria';
import { ShortlistDialog } from '../actions/shortlist-dialog';
import type { DomainTarget, ScopeOption } from '../actions/types';
import { WatchDialog } from '../actions/watch-dialog';
import { DomainDock } from '../domain/domain-panel';
import { RelativeTime } from '../domain/time';
import { JobView } from '../jobs/job-view';
import { ExtensionChips } from '../search/extension-chips';
import { PreviewLine } from '../search/preview-line';
import { SearchField } from '../search/search-field';
import { SearchOptionsPopover } from '../search/search-options';
import { DEFAULT_OPTIONS, type SearchOptions, useDefaultExtensions, useInputPreview, useSubmitSearch } from '../search/search-state';
import { ConfirmDialog } from '../ui/alert-dialog';
import { EmptyState, ErrorState, Page } from '../states';
import { StatusDot } from '../status';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGap, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Segmented } from '../ui/segmented';
import { Skeleton, SkeletonRows } from '../ui/skeleton';
import { GRID_MAX_ITEMS, GRID_MAX_LABELS, type ListFilters, groupCounts, labelOf, resolveSection, sectionFilter, useAllResults, useRecheckOverlay, withOverride } from './data';
import { ResultGrid, type ResultActions } from './result-grid';
import { ListFilterBar, type ListSelection, ResultList } from './result-list';

type View = 'grid' | 'list';

function filtersFromParams(params: URLSearchParams): ListFilters {
  const filters: ListFilters = {};
  const q = params.get('q');
  if (q) filters.q = q;
  const suffixes = params.get('suffixes');
  if (suffixes) filters.suffixes = suffixes.split(',').filter(Boolean);
  const maxPrice = params.get('maxPrice');
  if (maxPrice && /^\d+(\.\d+)?$/.test(maxPrice)) filters.maxPrice = maxPrice;
  const maxLength = Number(params.get('maxLength'));
  if (Number.isInteger(maxLength) && maxLength > 0 && maxLength <= 63) filters.maxLength = maxLength;
  const sort = params.get('sort');
  if (sort === 'length' || sort === 'domain' || sort === 'input') filters.sort = sort;
  const confirmations = params.get('confirmations');
  if (confirmations) filters.confirmations = confirmations.split(',').filter(Boolean) as ListFilters['confirmations'];
  const saved = params.get('inCollection');
  if (saved === 'true' || saved === 'false') filters.saved = saved === 'true';
  const currency = params.get('priceCurrency');
  if (currency && /^[A-Z]{3}$/.test(currency)) filters.currency = currency;
  const outcomes = params.get('outcomes');
  if (outcomes) filters.outcomes = outcomes.split(',').filter(Boolean);
  const collectionId = params.get('collectionId');
  if (collectionId) filters.collectionId = collectionId;
  const resolved = params.get('resolved');
  if (resolved === 'true' || resolved === 'false') filters.resolved = resolved === 'true';
  if (params.get('order') === 'desc') filters.order = 'desc';
  return filters;
}

function replaceParams(mutate: (params: URLSearchParams) => void) {
  const params = new URLSearchParams(window.location.search);
  mutate(params);
  const query = params.toString();
  window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
}

/** Search bar prefilled with this search; Enter starts a new one. */
function ResultsSearchBar({ job, inputRef }: { job: Job; inputRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const router = useRouter();
  const defaults = useDefaultExtensions();
  const submit = useSubmitSearch();
  const [text, setText] = useState(job.input.text ?? '');
  const [extensions, setExtensions] = useState(job.input.extensions);
  const [options, setOptions] = useState<SearchOptions>({ ...DEFAULT_OPTIONS, format: job.input.format ?? 'auto', csvColumn: job.input.csvColumn ?? '' });
  const [fileName, setFileName] = useState<string | null>(null);
  // The text arrives with the job (lists and events omit it); fill it once when it does.
  const filled = useRef(Boolean(job.input.text));
  useEffect(() => {
    if (!filled.current && job.input.text) {
      filled.current = true;
      setText(job.input.text);
    }
  }, [job.input.text]);
  const [focused, setFocused] = useState(false);
  const preview = useInputPreview(text, options, extensions);
  const changed = text !== (job.input.text ?? '') || extensions.join() !== job.input.extensions.join() || options.recheck || Boolean(fileName);
  const checks = preview.current?.counts.totalChecks ?? 0;
  return (
    <div className="flex shrink-0 flex-col gap-1.5" onFocus={() => setFocused(true)} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}>
      <SearchField
        size="compact"
        maxLines={focused ? 6 : 1}
        inputRef={inputRef}
        value={text}
        onChange={setText}
        mode="names"
        onModeChange={() => router.push(`/?mode=ideas&q=${encodeURIComponent(text.includes('\n') ? '' : text)}`)}
        onSubmit={() => submit.mutate({ text, extensions, options, fileName })}
        canSubmit={checks > 0}
        pending={submit.isPending}
        onFile={(file) => {
          setText(file.text);
          setFileName(file.fileName);
          setOptions((o) => ({ ...o, format: file.format }));
        }}
        fileName={fileName}
        onClearFile={() => {
          setText('');
          setFileName(null);
        }}
        options={<SearchOptionsPopover value={options} onChange={setOptions} />}
      />
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-0.5">
        <ExtensionChips
          compact
          value={extensions}
          onChange={(next) => {
            setExtensions(next);
            defaults.remember(next);
          }}
        />
        {changed ? <PreviewLine preview={preview.current ?? preview.data} stale={preview.stale} has={preview.has} /> : null}
      </div>
    </div>
  );
}

function Progress({ job }: { job: Job }) {
  const client = useQueryClient();
  const cancel = useMutation({
    mutationFn: async () => (await api.call('cancelJob', { params: { id: job.id } })).data,
    onSuccess: (data) => client.setQueryData(qk.job(job.id), data),
  });
  const { counters } = job;
  const percent = counters.total ? Math.round((counters.finished / counters.total) * 1000) / 10 : 0;
  return (
    <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground" data-testid="search-progress">
      <div role="progressbar" aria-label="Checked" aria-valuemin={0} aria-valuemax={counters.total} aria-valuenow={counters.finished} className="h-[3px] flex-1 overflow-hidden rounded-full bg-input">
        <div className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${Math.max(percent, 2)}%` }} />
      </div>
      <span className="tabular">
        {job.state === 'queued' ? 'Starting' : `${formatCount(counters.finished)} of ${formatCount(counters.total)} checked`}
      </span>
      {job.nextRetryAt ? (
        <span>
          Some registries asked to slow down; next try <RelativeTime iso={job.nextRetryAt} />
        </span>
      ) : null}
      {job.state === 'queued' || job.state === 'running' ? (
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
          <CircleStop className="size-3.5" />
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

function Summary({ job }: { job: Job }) {
  const c = groupCounts(job);
  const running = !isTerminal(job);
  const item = (tone: 'positive' | 'neutral' | 'caution' | 'muted', label: string, value: number, unresolved?: boolean, testId?: string) => (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" data-testid={testId}>
      <StatusDot tone={tone} unresolved={unresolved} />
      <span className="font-medium tabular">{formatCount(value)}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" aria-live="polite" data-testid="result-summary">
      {item('positive', 'not registered', c.free, false, 'count-free')}
      {item('neutral', 'taken', c.taken, false, 'count-taken')}
      {c.problem ? item('caution', "couldn't check", c.problem, true, 'count-problem') : null}
      {c.pending && !running ? item('caution', 'not checked', c.pending, true) : null}
      {job.destinations.length ? (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="inline-flex h-6 items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground">
              Checked with {plural(job.destinations.length, 'registry server')}
              <ChevronDown aria-hidden className="size-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto max-w-[min(32rem,calc(100vw-2rem))]">
            <ul aria-label="Servers this search sent names to" className="flex flex-col gap-1 font-mono text-xs">
              {job.destinations.map((destination) => (
                <li key={destination} className="break-all">
                  {destination}
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

function ToolbarButton({ label, children, ...props }: { label: string; children: React.ReactNode } & Omit<React.ComponentProps<typeof Button>, 'children'>) {
  return (
    <Button size="sm" variant="ghost" className="px-2 @2xl/pane:px-2.5" {...props}>
      {children}
      <span className="sr-only @2xl/pane:not-sr-only">{label}</span>
    </Button>
  );
}

type DialogName = 'list' | 'watch' | 'quotes' | 'names' | 'diagnostics' | 'criteria' | 'delete' | null;

function SearchResults({ job }: { job: Job }) {
  const router = useRouter();
  const client = useQueryClient();
  const searchParams = useSearchParams();
  const isWide = useIsWide();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const names = useProviderNames();
  const horizon = useHorizon();
  const currency = usePriceCurrency();
  const collections = useCollections();
  const watches = useWatchIndex();
  const quickSave = useQuickSave();
  const quickWatch = useQuickWatch();
  const overlay = useRecheckOverlay();
  const [buyFor, setBuyFor] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [artifact, setArtifact] = useState<ArtifactRequest | null>(null);
  const [selection, setSelection] = useState<ListSelection>(new Map());
  const [bulkTarget, setBulkTarget] = useState<DomainTarget | null>(null);

  const detail = searchParams.get('d');
  const userView = searchParams.get('view') as View | null;
  const [filters, setFiltersState] = useState<ListFilters>(() => filtersFromParams(new URLSearchParams(searchParams.toString())));
  const selectedProviders = useMemo(() => providersFromParams(new URLSearchParams(searchParams.toString())), [searchParams]);
  const running = !isTerminal(job);

  const canGrid = job.counters.total <= GRID_MAX_ITEMS;
  const all = useAllResults(job.id, canGrid, running);
  const labelCount = useMemo(() => new Set(all.items.map(labelOf)).size, [all.items]);
  // A results filter (e.g. restored from a saved search) only applies to the list, so it opens there.
  const [filteredOnOpen] = useState(() => Object.keys(filtersFromParams(new URLSearchParams(searchParams.toString()))).length > 0);
  const autoView: View | null = !canGrid || filteredOnOpen ? 'list' : all.complete ? (labelCount <= GRID_MAX_LABELS ? 'grid' : 'list') : null;
  const view: View | null = userView === 'list' || (userView === 'grid' && canGrid) ? userView : autoView;

  // Suffixes to price: the search's extensions, full domains it held, and suffixes the list has loaded.
  const [listSuffixes, setListSuffixes] = useState<string[]>([]);
  const addListSuffixes = useCallback((next: string[]) => setListSuffixes((current) => (next.every((s) => current.includes(s)) ? current : uniq([...current, ...next]))), []);
  const suffixes = useMemo(
    () => uniq([...job.input.extensions, ...all.items.map((i) => i.suffix).filter((s): s is string => Boolean(s)), ...listSuffixes]),
    [job.input.extensions, all.items, listSuffixes],
  );
  const prices = useSuffixPrices(suffixes, horizon);
  const gridItems = useMemo(() => all.items.map((item) => withOverride(item, overlay.overrides)), [all.items, overlay.overrides]);

  const setFilters = useCallback((next: ListFilters) => {
    setFiltersState(next);
    setSelection(new Map());
    replaceParams((params) => {
      for (const key of ['q', 'suffixes', 'maxPrice', 'maxLength', 'outcomes', 'sort', 'order', 'priceCurrency', 'confirmations', 'inCollection', 'collectionId', 'resolved', 'states']) params.delete(key);
      if (next.q) params.set('q', next.q);
      if (next.suffixes?.length) params.set('suffixes', next.suffixes.join(','));
      if (next.maxPrice) params.set('maxPrice', next.maxPrice);
      if (next.maxLength) params.set('maxLength', String(next.maxLength));
      if (next.sort) params.set('sort', next.sort);
      if (next.confirmations?.length) params.set('confirmations', next.confirmations.join(','));
      if (next.saved !== undefined) params.set('inCollection', String(next.saved));
      if (next.currency && next.maxPrice) params.set('priceCurrency', next.currency);
      if (next.outcomes?.length) params.set('outcomes', next.outcomes.join(','));
      if (next.collectionId) params.set('collectionId', next.collectionId);
      if (next.resolved !== undefined) params.set('resolved', String(next.resolved));
      if (next.order === 'desc') params.set('order', 'desc');
    });
  }, []);

  const open = useCallback(
    (domain: string) => {
      if (!isWide) {
        router.push(`/domains/${encodeURIComponent(domain)}`);
        return;
      }
      replaceParams((params) => params.set('d', domain));
    },
    [isWide, router],
  );
  const closeDetail = useCallback(() => replaceParams((params) => params.delete('d')), []);
  const setView = (next: View) => replaceParams((params) => params.set('view', next));

  const defaultList = defaultListOf(collections.data);
  const actions: ResultActions = {
    open,
    toggleSave: (item: JobItem) => {
      const inDefault = defaultList ? item.collectionIds.includes(defaultList.id) : false;
      quickSave.mutate({ domains: [item.subject], save: !inDefault });
    },
    watch: (domain: string) => {
      const existing = watches.index.get(domain);
      if (existing) {
        toast(`Already watching ${domain}`, { action: { label: 'Open', onClick: () => router.push(`/watching/${existing.id}`) } });
        return;
      }
      quickWatch.mutate(domain);
    },
    retry: (domain: string) => overlay.recheck([domain]),
  };

  // "/" focuses the search bar.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const resume = useMutation({
    mutationFn: async () => (await api.call('resumeJob', { params: { id: job.id } })).data,
    onSuccess: (data) => client.setQueryData(qk.job(job.id), data),
  });
  const remove = useMutation({
    mutationFn: async () => api.call('deleteJob', { params: { id: job.id } }),
    onSuccess: () => {
      toast.success('Search deleted');
      void client.invalidateQueries({ queryKey: qk.history() });
      router.push('/history');
    },
  });
  const saveCriteria = useMutation({
    mutationFn: async (choice: { name: string; providerIds: string[]; budget: { amount: string; currency: string } | null }) => {
      // Saved criteria keep text but not parse options, so a CSV search saves the values of the column it read.
      let input = job.input.text ?? null;
      if (input && job.input.format === 'csv') {
        const parsed = (
          await api.call('previewInput', { body: { text: input, format: 'csv', csvColumn: job.input.csvColumn ?? undefined, extensions: job.input.extensions } })
        ).data;
        input = uniq(parsed.rows.map((r) => r.original.trim()).filter(Boolean)).join('\n');
      }
      return (
        await api.call('createCriteria', {
          body: {
            name: choice.name,
            filter: {
              ...(filters.q ? { q: filters.q } : {}),
              ...(filters.suffixes?.length ? { suffixes: filters.suffixes } : {}),
              ...(filters.maxLength ? { maxLength: filters.maxLength } : {}),
              ...(filters.confirmations?.length ? { confirmations: filters.confirmations } : {}),
              ...(filters.saved !== undefined ? { inCollection: filters.saved } : {}),
              ...(filters.sort ? { sort: filters.sort } : {}),
              ...(filters.order ? { order: filters.order } : {}),
              ...(filters.outcomes?.length ? { outcomes: filters.outcomes } : {}),
              ...(filters.collectionId ? { collectionId: filters.collectionId } : {}),
              ...(filters.resolved !== undefined ? { resolved: filters.resolved } : {}),
            },
            extensions: job.input.extensions,
            providerIds: choice.providerIds,
            budget: choice.budget,
            input,
          },
        })
      ).data;
    },
    onSuccess: (criteria) => {
      void client.invalidateQueries({ queryKey: qk.criteria });
      toast.success(`Saved ${criteria.name}`, { action: { label: 'Saved', onClick: () => router.push('/saved') } });
    },
  });

  const problemCount = groupCounts(job).problem;
  const retryProblems = async () => {
    const items = canGrid ? all.items.filter((i) => i.outcome && !['registered', 'no_record'].includes(i.outcome)) : await resolveSection(job.id, sectionFilter('problem', {}, currency));
    const domains = uniq(items.filter((i) => i.outcome !== 'invalid' && i.outcome !== 'unsupported').map((i) => i.subject));
    if (domains.length === 0) toast('Nothing to check again.');
    else overlay.recheck(domains);
  };

  const selectionItems = [...selection.values()];
  const selectionTarget: DomainTarget = { count: selection.size, resolveDomains: async () => uniq(selectionItems.map((i) => i.subject)) };
  const jobTarget: DomainTarget = {
    count: job.counters.total,
    resolveDomains: async () => uniq((canGrid ? all.items : await resolveSection(job.id, {})).map((i) => i.subject)),
  };
  const target = bulkTarget ?? (selection.size ? selectionTarget : jobTarget);
  const openBulk = (name: DialogName, t: DomainTarget) => {
    setBulkTarget(t);
    setDialog(name);
  };

  const exportScopes: ScopeOption[] = [
    {
      value: 'selection',
      label: `Selected rows (${formatCount(selection.size)})`,
      disabled: selection.size === 0,
      build: async () => ({ kind: 'selection', itemIds: selectionItems.map((i) => i.id) }),
    },
    {
      value: 'free',
      label: `Not registered (${formatCount(groupCounts(job).free)})`,
      build: async () => ({ kind: 'filter', jobId: job.id, filter: { outcomes: ['no_record'] } }),
    },
    { value: 'job', label: `Whole search (${formatCount(job.counters.total)})`, build: async () => ({ kind: 'job', jobId: job.id }) },
  ];

  const canResume = (job.state === 'interrupted' || job.state === 'cancelled') && job.counters.pending + job.counters.interrupted > 0;
  const panelOpen = Boolean(detail) && isWide;

  return (
    <div className="flex min-w-0 flex-1 lg:min-h-0">
      <Page className="gap-3">
        <h1 className="sr-only">{job.label ?? 'Search results'}</h1>
        <ResultsSearchBar key={job.id} job={job} inputRef={inputRef} />
        {running ? <Progress job={job} /> : null}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <Summary job={job} />
          <div className="flex items-center gap-1.5">
            {canResume ? (
              <Button size="sm" variant="secondary" disabled={resume.isPending} onClick={() => resume.mutate()}>
                <Play />
                Resume
              </Button>
            ) : null}
            {problemCount && !running ? (
              <Button size="sm" variant="ghost" disabled={overlay.pending} onClick={() => void retryProblems()}>
                <RotateCw />
                Check again
              </Button>
            ) : null}
            {canGrid && view ? (
              <Segmented<View>
                aria-label="View"
                size="sm"
                value={view}
                onValueChange={setView}
                options={[
                  { value: 'grid', label: <LayoutGrid className="size-4" aria-label="Grid" /> },
                  { value: 'list', label: <List className="size-4" aria-label="List" /> },
                ]}
              />
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="More search actions">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setArtifact({ kind: 'export', defaultScope: selection.size ? 'selection' : 'job' })}>
                  <Download />
                  Export
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setArtifact({ kind: 'snapshot', defaultScope: selection.size ? 'selection' : 'job' })}>
                  <Camera />
                  Snapshot
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openBulk('quotes', jobTarget)}>
                  <Tag />
                  Get quotes for every name
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog('criteria')}>
                  <Save />
                  Save this search
                </DropdownMenuItem>
                {isTerminal(job) ? (
                  <>
                    <DropdownMenuGap />
                    <DropdownMenuItem className="text-negative" onSelect={() => setDialog('delete')}>
                      <Trash />
                      Delete search
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {view === 'list' ? <ListFilterBar filters={filters} onChange={setFilters} suffixes={suffixes} currency={currency} /> : null}

        <div className="@container/pane relative flex min-h-0 flex-1 flex-col max-lg:h-[calc(100dvh-4rem)] max-lg:flex-none">
          {all.isError ? (
            <ErrorState error={all.error} onRetry={() => all.refetch()} />
          ) : view === null ? (
            <SkeletonRows rows={8} />
          ) : view === 'grid' ? (
            gridItems.length ? (
              <ResultGrid
                running={running}
                savedListId={defaultList?.id ?? null}
                items={gridItems}
                extensions={job.input.extensions}
                prices={prices.map}
                currency={currency}
                horizon={horizon}
                names={names}
                activeDomain={panelOpen ? detail : null}
                checking={overlay.checking}
                watchIndex={watches.index}
                buyFor={buyFor}
                onBuyFor={setBuyFor}
                actions={actions}
              />
            ) : (
              <EmptyState>{running ? 'Results appear as checks finish.' : 'Nothing was checked.'}</EmptyState>
            )
          ) : (
            <ResultList
              job={job}
              savedListId={defaultList?.id ?? null}
              filters={filters}
              prices={prices.map}
              currency={currency}
              horizon={horizon}
              names={names}
              activeDomain={panelOpen ? detail : null}
              checking={overlay.checking}
              overrides={overlay.overrides}
              watchIndex={watches.index}
              buyFor={buyFor}
              onBuyFor={setBuyFor}
              actions={actions}
              selection={selection}
              onSelection={setSelection}
              poll={running}
              bottomInset={selection.size ? 64 : 0}
              onSuffixes={addListSuffixes}
            />
          )}

          {selection.size > 0 && view === 'list' ? (
            <div
              role="toolbar"
              aria-label="Selected results"
              className={cn(
                'z-30 flex max-w-[calc(100%-1rem)] flex-nowrap items-center gap-0.5 overflow-x-auto rounded-xl bg-popover p-1.5 shadow-[0_8px_40px_rgb(0_0_0/0.18)] dark:shadow-[0_8px_40px_rgb(0_0_0/0.7)]',
                'absolute bottom-3 left-1/2 -translate-x-1/2 max-lg:fixed max-lg:bottom-4 max-lg:max-w-[calc(100vw-1.5rem)]',
              )}
            >
              <span className="whitespace-nowrap px-2 text-sm font-medium tabular">{formatCount(selection.size)} selected</span>
              <ToolbarButton label="Save" onClick={() => openBulk('list', selectionTarget)}>
                <Bookmark />
              </ToolbarButton>
              <ToolbarButton label="Watch" onClick={() => openBulk('watch', selectionTarget)}>
                <Eye />
              </ToolbarButton>
              <ToolbarButton label="Check again" disabled={overlay.pending} onClick={() => overlay.recheck(uniq(selectionItems.map((i) => i.subject)))}>
                <RotateCw />
              </ToolbarButton>
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
                  <DropdownMenuItem onSelect={() => openBulk('quotes', selectionTarget)}>
                    <Tag />
                    Get quotes
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openBulk('names', selectionTarget)}>
                    <Fingerprint />
                    Name checks
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openBulk('diagnostics', selectionTarget)}>
                    <Stethoscope />
                    Diagnostics
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setArtifact({ kind: 'snapshot', defaultScope: 'selection' })}>
                    <Camera />
                    Snapshot
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="icon-sm" variant="quiet" aria-label="Clear selection" onClick={() => setSelection(new Map())}>
                <X />
              </Button>
            </div>
          ) : null}
        </div>
      </Page>

      {panelOpen && detail ? <DomainDock name={detail} onClose={closeDetail} /> : null}

      <ShortlistDialog open={dialog === 'list'} onOpenChange={(o) => setDialog(o ? 'list' : null)} target={target} />
      <WatchDialog open={dialog === 'watch'} onOpenChange={(o) => setDialog(o ? 'watch' : null)} target={target} />
      <ProviderRequestDialog open={dialog === 'quotes'} onOpenChange={(o) => setDialog(o ? 'quotes' : null)} target={target} defaultSelected={selectedProviders} />
      <NameCheckDialog open={dialog === 'names'} onOpenChange={(o) => setDialog(o ? 'names' : null)} target={target} />
      <DiagnosticsDialog open={dialog === 'diagnostics'} onOpenChange={(o) => setDialog(o ? 'diagnostics' : null)} target={target} />
      <ArtifactDialogsHost request={artifact} onClose={() => setArtifact(null)} scopes={exportScopes} />
      <SaveCriteriaDialog
        open={dialog === 'criteria'}
        onOpenChange={(o) => setDialog(o ? 'criteria' : null)}
        summary={<p className="font-mono text-[13px]">{job.input.extensions.map((e) => `.${e}`).join(' ')}</p>}
        initialProviders={selectedProviders}
        initialBudget={{ amount: filters.maxPrice ?? '', currency: filters.currency ?? null }}
        pending={saveCriteria.isPending}
        onSave={(choice) => saveCriteria.mutateAsync(choice)}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => setDialog(o ? 'delete' : null)}
        title="Delete this search?"
        description="The search and its results list are removed. Evidence used by saved lists or other searches is kept."
        confirmLabel="Delete search"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

/** /search/[id]: the results of one search, or the item list of any other job. */
export function SearchResultsPage({ jobId }: { jobId: string }) {
  const job = useLiveJob(jobId);
  if (job.isPending) {
    return (
      <Page>
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-7 w-96" />
        <SkeletonRows rows={10} />
      </Page>
    );
  }
  if (job.isError) {
    return (
      <Page>
        <h1 className="text-base font-semibold">Search</h1>
        <ErrorState error={job.error} onRetry={() => job.refetch()} />
      </Page>
    );
  }
  if (job.data.type !== 'registry_scan') return <JobView jobId={jobId} />;
  return <SearchResults job={job.data} />;
}

