'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Camera, ChevronRight, Download, Ellipsis, Eye, NotebookPen, Pencil, RotateCw, Search, ShoppingBag, SlidersHorizontal, Tag, Trash, X } from 'lucide-react';
import { toast } from 'sonner';
import type { Collection, CollectionEntry } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { NOT_REGISTERED_HINT, registryStatus } from '@/lib/labels';
import { formatCount, formatDate, formatMoney, plural } from '@/lib/format';
import { cheapestLine, priceLines, useEnabledProviders, useHorizon, usePriceCurrency, useProviderNames, useSuffixPrices } from '@/lib/prices';
import { qk, useProviders, useSettings } from '@/lib/queries';
import { useQuickWatch, useWatchIndex } from '@/lib/saved';
import { useIdempotency } from '@/lib/use-idempotency';
import { isTerminal, useLiveJob } from '@/lib/use-job';
import { useIsWide } from '@/lib/use-media-query';
import { useNow } from '@/lib/use-now';
import { cn, uniq } from '@/lib/utils';
import { ArtifactDialogsHost, type ArtifactRequest } from '../actions/artifact-host';
import { ProviderRequestDialog } from '../actions/provider-request-dialog';
import type { DomainTarget, ScopeOption } from '../actions/types';
import { DomainName } from '../domain/domain-name';
import { RelativeTime } from '../domain/time';
import { WatchFormDialog } from '../watching/watch-form';
import { BuyMenu } from '../results/buy-menu';
import { EmptyState, ErrorState } from '../states';
import { StatusLabel } from '../status';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGap, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Dialog, DialogContent, DialogFooter } from '../ui/dialog';
import { Input, Textarea } from '../ui/input';
import { Field } from '../ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Segmented } from '../ui/segmented';
import { Select } from '../ui/select';
import { Skeleton, SkeletonRows } from '../ui/skeleton';
import { Tooltip } from '../ui/tooltip';
import { type CompareOptions, DEFAULT_COMPARE, ProviderComparison } from './comparison';

const PAGE = 200;

/** Notes edited in place: click to type, Enter or leaving the field saves, Escape cancels. */
function InlineNotes({ collectionId, entry }: { collectionId: string; entry: CollectionEntry }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.notes ?? '');
  const save = useMutation({
    mutationFn: async (notes: string) => api.call('patchCollectionEntry', { params: { id: collectionId, domain: entry.domain }, body: { notes: notes.trim() || null } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: qk.collectionEntries(collectionId) }),
  });
  const commit = () => {
    setEditing(false);
    if (value.trim() !== (entry.notes ?? '')) save.mutate(value);
  };
  if (editing) {
    return (
      <input
        autoFocus
        aria-label={`Notes for ${entry.domain}`}
        value={value}
        maxLength={20_000}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          else if (event.key === 'Escape') {
            event.stopPropagation();
            setValue(entry.notes ?? '');
            setEditing(false);
          }
        }}
        className="h-7 w-full min-w-0 rounded-md bg-input px-2 text-sm outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        setValue(entry.notes ?? '');
        setEditing(true);
      }}
      title={entry.notes ?? undefined}
      aria-label={entry.notes ? `Edit notes for ${entry.domain}` : `Add notes for ${entry.domain}`}
      className={cn('flex h-7 w-full min-w-0 items-center rounded-md px-2 text-left text-sm transition-colors hover:bg-background', entry.notes ? 'text-foreground' : 'text-transparent hover:text-muted-foreground group-hover/row:text-muted-foreground')}
    >
      <span className="truncate">{entry.notes || 'Add note'}</span>
    </button>
  );
}

/** Notes behind an icon when the table is too narrow for the notes column. */
function NotesPopover({ collectionId, entry }: { collectionId: string; entry: CollectionEntry }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(entry.notes ?? '');
  const save = useMutation({
    mutationFn: async () => api.call('patchCollectionEntry', { params: { id: collectionId, domain: entry.domain }, body: { notes: value.trim() || null } }),
    onSuccess: () => {
      setOpen(false);
      void client.invalidateQueries({ queryKey: qk.collectionEntries(collectionId) });
    },
  });
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setValue(entry.notes ?? '');
      }}
    >
      <Tooltip content={entry.notes ?? 'Add a note'}>
        <PopoverTrigger asChild>
          <Button
            size="icon-xs"
            variant="quiet"
            aria-label={entry.notes ? `Edit notes for ${entry.domain}` : `Add notes for ${entry.domain}`}
            className={cn(entry.notes ? 'text-foreground' : 'opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100')}
          >
            <NotebookPen />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-72">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Input autoFocus aria-label="Notes" value={value} maxLength={20_000} onChange={(e) => setValue(e.target.value)} />
          <Button type="submit" size="sm" variant="primary" disabled={save.isPending}>
            Save note
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function CompareOptionsPopover({ value, onChange }: { value: CompareOptions; onChange: (next: CompareOptions) => void }) {
  const settings = useSettings();
  const providers = useProviders();
  const horizon = value.horizon ?? settings.data?.comparison.horizonYears ?? 3;
  const settingsCurrency = settings.data?.comparison.currency ?? null;
  const rateCurrencies = [...new Set((settings.data?.fxRates ?? []).flatMap((r) => [r.from, r.to]))].sort();
  const registrars = (providers.data ?? []).filter((p) => p.kind === 'registrar');
  const changed = JSON.stringify(value) !== JSON.stringify(DEFAULT_COMPARE);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant={changed ? 'secondary' : 'ghost'}>
          <SlidersHorizontal />
          {plural(horizon, 'year')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3 p-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Horizon" htmlFor="compare-horizon">
            <Select
              id="compare-horizon"
              value={String(horizon)}
              onValueChange={(v) => onChange({ ...value, horizon: Number(v) })}
              options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: plural(i + 1, 'year') }))}
            />
          </Field>
          <Field label="Currency" htmlFor="compare-currency">
            <Select
              id="compare-currency"
              value={value.currency}
              onValueChange={(currency) => onChange({ ...value, currency })}
              options={[
                { value: 'default', label: settingsCurrency ? `Default, ${settingsCurrency}` : 'Original currencies' },
                ...(settingsCurrency ? [{ value: 'original', label: 'Original currencies' }] : []),
                ...rateCurrencies.filter((c) => c !== settingsCurrency).map((c) => ({ value: c, label: c })),
              ]}
            />
          </Field>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Compare</span>
          <Segmented
            aria-label="Purchase path"
            size="sm"
            value={value.path}
            onValueChange={(path) => onChange({ ...value, path })}
            options={[
              { value: 'new_registration', label: 'Registration' },
              { value: 'renewal', label: 'Renewal' },
              { value: 'transfer', label: 'Transfer' },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Providers</span>
          <ul className="flex max-h-40 flex-col overflow-y-auto">
            {registrars.map((p) => (
              <li key={p.id}>
                <label className="flex h-8 items-center gap-2.5 rounded-md px-1.5 text-sm hover:bg-hover">
                  <Checkbox
                    checked={value.providerIds.length === 0 || value.providerIds.includes(p.id)}
                    onCheckedChange={(v) => {
                      const current = value.providerIds.length ? value.providerIds : registrars.map((r) => r.id);
                      const next = v === true ? uniq([...current, p.id]) : current.filter((id) => id !== p.id);
                      onChange({ ...value, providerIds: next.length === registrars.length ? [] : next });
                    }}
                  />
                  {p.name}
                </label>
              </li>
            ))}
          </ul>
        </div>
        {changed ? (
          <Button size="sm" variant="quiet" onClick={() => onChange(DEFAULT_COMPARE)}>
            Reset
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ListTitle({ collection, count }: { collection: Collection; count: number }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(collection.name);
  const rename = useMutation({
    mutationFn: async () => (await api.call('patchCollection', { params: { id: collection.id }, body: { name: value.trim() } })).data,
    onSuccess: (updated) => {
      client.setQueryData(qk.collection(collection.id), updated);
      void client.invalidateQueries({ queryKey: qk.collections });
      setEditing(false);
    },
  });
  if (editing) {
    return (
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim() && value.trim() !== collection.name) rename.mutate();
          else setEditing(false);
        }}
      >
        <Input autoFocus aria-label="List name" value={value} maxLength={200} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} className="h-8 w-60 text-base font-semibold" />
        <Button type="submit" size="sm" variant="primary" disabled={rename.isPending}>
          Save
        </Button>
      </form>
    );
  }
  return (
    <h2 className="group/title flex min-w-0 items-center gap-1.5 text-base font-semibold tracking-tight">
      <span className="truncate">{collection.name}</span>
      <span className="text-sm font-normal text-muted-foreground tabular">{plural(count, 'name')}</span>
      <Button
        size="icon-xs"
        variant="quiet"
        aria-label="Rename list"
        className="-ml-1 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/title:opacity-100"
        onClick={() => {
          setValue(collection.name);
          setEditing(true);
        }}
      >
        <Pencil />
      </Button>
    </h2>
  );
}

/** Notes for the whole list, edited in a dialog from the list menu. */
function ListNotesDialog({ collection, open, onOpenChange }: { collection: Collection; open: boolean; onOpenChange: (open: boolean) => void }) {
  const client = useQueryClient();
  const [value, setValue] = useState(collection.notes ?? '');
  const save = useMutation({
    mutationFn: async () => (await api.call('patchCollection', { params: { id: collection.id }, body: { notes: value.trim() || null } })).data,
    onSuccess: (updated) => {
      client.setQueryData(qk.collection(collection.id), updated);
      void client.invalidateQueries({ queryKey: qk.collections });
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Notes for ${collection.name}`}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Textarea autoFocus aria-label="List notes" value={value} maxLength={20_000} onChange={(e) => setValue(e.target.value)} className="min-h-32" />
          <DialogFooter className="mt-0">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={save.isPending || value === (collection.notes ?? '')}>
              Save notes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Rechecks names and refreshes the list when the check finishes. */
function useListRecheck(collectionId: string, label: string) {
  const client = useQueryClient();
  const idempotency = useIdempotency();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useLiveJob(jobId);
  const done = isTerminal(job.data);
  useEffect(() => {
    if (jobId && done) {
      void client.invalidateQueries({ queryKey: qk.collectionEntries(collectionId) });
      toast.success('Recheck finished');
    }
  }, [client, collectionId, jobId, done]);
  const start = useMutation({
    mutationFn: async (domains: string[]) => {
      const body = { domains, label: `Recheck ${label}` };
      return (await api.call('createRecheck', { body, idempotencyKey: idempotency.keyFor(body) })).data;
    },
    onSuccess: (created) => {
      idempotency.reset();
      setJobId(created.id);
    },
  });
  return { start: (domains: string[]) => start.mutate(domains), running: start.isPending || Boolean(jobId && job.data && !done), progress: job.data?.counters };
}

const COLS =
  'grid-cols-[2rem_minmax(0,1fr)_9.5rem_7rem] @3xl:grid-cols-[2rem_minmax(0,1fr)_9.5rem_minmax(7rem,9rem)_5.5rem_6rem_7rem] @5xl:grid-cols-[2rem_minmax(0,1.3fr)_9.5rem_minmax(7rem,9rem)_5.5rem_6rem_minmax(8rem,1fr)_7rem]';
const SHOW = { price: 'hidden @3xl:flex', notes: 'hidden @5xl:flex' };

/** One saved list: fresh status, cost over time per provider, and where to buy. */
export function ListView({ collection, onDeleted }: { collection: Collection; onDeleted: () => void }) {
  const router = useRouter();
  const client = useQueryClient();
  const searchParams = useSearchParams();
  const isWide = useIsWide();
  const now = useNow();
  const settings = useSettings();
  const names = useProviderNames();
  const enabled = useEnabledProviders();
  const currency = usePriceCurrency();
  const settingsHorizon = useHorizon();
  const watches = useWatchIndex();
  const quickWatch = useQuickWatch();
  const [options, setOptions] = useState<CompareOptions>(DEFAULT_COMPARE);
  const horizon = options.horizon ?? settingsHorizon;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<'quotes' | 'watch' | 'delete' | 'remove' | 'notes' | null>(null);
  const [artifact, setArtifact] = useState<ArtifactRequest | null>(null);
  const [buyFor, setBuyFor] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const detail = searchParams.get('d');

  const entries = useInfiniteQuery({
    queryKey: qk.collectionEntries(collection.id),
    queryFn: ({ pageParam, signal }) => api.call('listCollectionEntries', { params: { id: collection.id }, query: { cursor: pageParam, limit: PAGE }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = useMemo(() => entries.data?.pages.flatMap((p) => p.data) ?? [], [entries.data]);
  // Filtering searches the whole list, so load the remaining pages once a filter is typed.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = entries;
  useEffect(() => {
    if (q.trim() && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [q, hasNextPage, isFetchingNextPage, fetchNextPage]);
  const shown = q.trim() ? rows.filter((r) => r.domain.includes(q.trim().toLowerCase()) || (r.notes ?? '').toLowerCase().includes(q.trim().toLowerCase())) : rows;
  const suffixes = useMemo(() => uniq(rows.map((r) => r.domain.split('.').slice(1).join('.'))), [rows]);
  const prices = useSuffixPrices(suffixes, horizon);
  const recheck = useListRecheck(collection.id, collection.name);

  const isStale = (r: CollectionEntry) => !r.registry || new Date(r.registry.staleAt).getTime() <= now;
  const stale = rows.filter(isStale);
  const never = stale.filter((r) => !r.registry).length;
  const freshMinutes = settings.data?.freshness.registryMinutes ?? 15;

  const allEntries = useCallback(async () => {
    const all: CollectionEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.call('listCollectionEntries', { params: { id: collection.id }, query: { cursor, limit: 1000 } });
      all.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return all;
  }, [collection.id]);
  const allDomains = useCallback(async () => (await allEntries()).map((e) => e.domain), [allEntries]);
  // The banner counts loaded rows; Recheck all covers every stale name in the list, loaded or not.
  const recheckAll = async () => recheck.start((hasNextPage ? (await allEntries()).filter(isStale) : stale).map((r) => r.domain));
  const target: DomainTarget = selected.size
    ? { count: selected.size, resolveDomains: async () => [...selected] }
    : { count: collection.entryCount, resolveDomains: allDomains };
  const scopes: ScopeOption[] = [
    { value: 'selection', label: `Selected names (${formatCount(selected.size)})`, disabled: selected.size === 0, build: async () => ({ kind: 'domains', domains: [...selected] }) },
    { value: 'collection', label: `Whole list (${formatCount(collection.entryCount)})`, build: async () => ({ kind: 'collection', collectionId: collection.id }) },
  ];

  const remove = useMutation({
    mutationFn: async (domains: string[]) => (await api.call('removeCollectionEntries', { params: { id: collection.id }, body: { domains } })).data,
    onSuccess: (result) => {
      toast.success(`Removed ${result.domains.length === 1 ? result.domains[0] : plural(result.domains.length, 'name')}`);
      setSelected((current) => new Set([...current].filter((d) => !result.domains.includes(d))));
      setDialog(null);
      void client.invalidateQueries({ queryKey: qk.collectionEntries(collection.id) });
      void client.invalidateQueries({ queryKey: qk.collection(collection.id) });
      void client.invalidateQueries({ queryKey: qk.collections });
      void client.invalidateQueries({ queryKey: ['jobResults'] });
    },
  });
  const deleteList = useMutation({
    mutationFn: async () => api.call('deleteCollection', { params: { id: collection.id } }),
    onSuccess: () => {
      toast.success(`Deleted ${collection.name}`);
      void client.invalidateQueries({ queryKey: qk.collections });
      onDeleted();
    },
  });

  const setDetail = (domain: string | null) => {
    const params = new URLSearchParams(window.location.search);
    if (domain) params.set('d', domain);
    else params.delete('d');
    const query = params.toString();
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
  };
  const open = (domain: string) => (isWide ? setDetail(domain) : router.push(`/domains/${encodeURIComponent(domain)}`));
  const toggle = (set: Set<string>, value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const allSelected = shown.length > 0 && shown.every((r) => selected.has(r.domain));
  const someSelected = shown.some((r) => selected.has(r.domain));
  const count = selected.size ? ` ${formatCount(selected.size)}` : '';

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-3 lg:min-h-0">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-center gap-1">
            <ListTitle key={collection.name} collection={collection} count={collection.entryCount} />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <CompareOptionsPopover value={options} onChange={setOptions} />
            <Button size="sm" variant="ghost" disabled={collection.entryCount === 0} onClick={() => setDialog('quotes')}>
              <Tag />
              Get quotes{count}
            </Button>
            <Button size="sm" variant="ghost" disabled={collection.entryCount === 0} onClick={() => setDialog('watch')}>
              <Eye />
              {selected.size ? `Watch${count}` : 'Watch all'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setArtifact({ kind: 'export', defaultScope: selected.size ? 'selection' : 'collection' })}>
              <Download />
              Export
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="More list actions">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setArtifact({ kind: 'snapshot', defaultScope: selected.size ? 'selection' : 'collection' })}>
                  <Camera />
                  Snapshot
                </DropdownMenuItem>
                <DropdownMenuItem disabled={recheck.running || collection.entryCount === 0} onSelect={() => void target.resolveDomains().then(recheck.start)}>
                  <RotateCw />
                  Recheck {selected.size ? 'selected' : 'every name'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog('notes')}>
                  <NotebookPen />
                  {collection.notes ? 'Edit list notes' : 'Add list notes'}
                </DropdownMenuItem>
                {selected.size ? (
                  <DropdownMenuItem onSelect={() => setDialog('remove')}>
                    <X />
                    Remove selected
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuGap />
                <DropdownMenuItem className="text-negative" onSelect={() => setDialog('delete')}>
                  <Trash />
                  Delete list
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        {collection.notes ? (
          <button type="button" onClick={() => setDialog('notes')} className="-mt-2 line-clamp-2 shrink-0 rounded-sm text-left text-sm text-muted-foreground hover:text-foreground" title="Edit list notes">
            {collection.notes}
          </button>
        ) : null}

        {stale.length > 0 && rows.length > 0 ? (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg bg-input px-3 py-2 text-sm" role="status" data-testid="freshness-banner">
            <span>
              {hasNextPage ? 'At least ' : null}
              {stale.length - never > 0 ? `${plural(stale.length - never, 'name')} ${stale.length - never === 1 ? 'was' : 'were'} checked over ${freshMinutes} minutes ago.` : null}
              {never > 0 ? ` ${plural(never, 'name')} ${never === 1 ? 'was' : 'were'} never checked.` : null}
            </span>
            <Button size="sm" variant="primary" disabled={recheck.running} onClick={() => void recheckAll()}>
              <RotateCw className={cn(recheck.running && 'motion-safe:animate-spin')} />
              {recheck.running ? `Checking ${recheck.progress ? `${recheck.progress.finished} of ${recheck.progress.total}` : ''}` : 'Recheck all'}
            </Button>
          </div>
        ) : null}

        {rows.length > 12 ? (
          <div className="relative w-full shrink-0 sm:w-64">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" aria-label="Filter this list" placeholder="Filter this list" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
        ) : null}

        {entries.isPending ? (
          <SkeletonRows rows={8} />
        ) : entries.isError ? (
          <ErrorState error={entries.error} onRetry={() => entries.refetch()} />
        ) : rows.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10">
            <p className="text-sm text-muted-foreground">No names in this list.</p>
            <Button size="sm" variant="secondary" asChild>
              <Link href="/">Search</Link>
            </Button>
          </div>
        ) : (
          <div className="@container relative -mx-1 min-h-0 flex-1 overflow-y-auto px-1" data-testid="entries-scroll">
            <div role="table" aria-label={`${collection.name} names`} className="text-sm">
              <div role="rowgroup" className="sticky top-0 z-10 bg-background">
                <div role="row" className={cn('grid h-8 items-center gap-x-3 px-1 text-xs font-medium text-muted-foreground', COLS)}>
                  <span role="columnheader" className="flex justify-center">
                    <Checkbox
                      aria-label="Select every name"
                      checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                      onCheckedChange={(v) => setSelected(v === true ? new Set(shown.map((r) => r.domain)) : new Set())}
                    />
                  </span>
                  <span role="columnheader">Domain</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader" className={SHOW.price}>
                    First year
                  </span>
                  <span role="columnheader" className={cn(SHOW.price, 'justify-end')}>
                    Renews
                  </span>
                  <span role="columnheader" className={cn(SHOW.price, 'justify-end')}>
                    {horizon} years
                  </span>
                  <span role="columnheader" className={SHOW.notes}>
                    Notes
                  </span>
                  <span role="columnheader">
                    <span className="sr-only">Actions</span>
                  </span>
                </div>
              </div>
              <div role="rowgroup">
                {shown.map((entry) => {
                  const suffix = entry.domain.split('.').slice(1).join('.');
                  const lines = priceLines(entry.domain, prices.map.get(suffix), entry.offers, horizon, names, { now, enabled });
                  const best = cheapestLine(lines, currency);
                  const outcome = entry.registry?.outcome ?? null;
                  const free = outcome === 'no_record';
                  const taken = outcome === 'registered';
                  // A taken name cannot be newly registered, so there is no registration cost to compare.
                  const comparable = !(taken && options.path === 'new_registration');
                  const isOpen = comparable && expanded.has(entry.domain);
                  const isSelected = selected.has(entry.domain);
                  const watched = watches.index.has(entry.domain);
                  const status = entry.registry ? registryStatus(entry.registry.outcome) : { label: 'Not checked', tone: 'muted' as const, unresolved: true };
                  const expires = entry.registry?.registration?.expiresAt ?? null;
                  return (
                    <Fragment key={entry.id}>
                      <div
                        role="row"
                        aria-selected={isSelected}
                        data-testid="saved-row"
                        data-domain={entry.domain}
                        className={cn('group/row grid min-h-11 items-center gap-x-3 rounded-md px-1 transition-colors', COLS, isSelected || detail === entry.domain ? 'bg-selected' : 'hover:bg-hover', isOpen && 'rounded-b-none bg-hover')}
                      >
                        <span role="cell" className="flex justify-center">
                          <Checkbox
                            aria-label={`Select ${entry.domain}`}
                            checked={isSelected}
                            onCheckedChange={() => setSelected((s) => toggle(s, entry.domain))}
                            className={cn(!isSelected && selected.size === 0 && 'opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100')}
                          />
                        </span>
                        <span role="cell" className="flex min-w-0 items-center gap-1">
                          {comparable ? (
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              aria-label={`${isOpen ? 'Hide' : 'Compare'} provider costs for ${entry.domain}`}
                              onClick={() => setExpanded((s) => toggle(s, entry.domain))}
                              className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                            >
                              <ChevronRight className={cn('size-4 transition-transform', isOpen && 'rotate-90')} />
                            </button>
                          ) : (
                            <span aria-hidden className="size-6 shrink-0" />
                          )}
                          <button type="button" onClick={() => open(entry.domain)} className={cn('flex min-w-0 rounded-sm text-left', free ? 'font-medium' : '')}>
                            <DomainName ascii={entry.domain} unicode={entry.unicode} />
                          </button>
                        </span>
                        <span role="cell" className="flex min-w-0 flex-col justify-center">
                          {free ? (
                            <Tooltip content={NOT_REGISTERED_HINT}>
                              <span className="inline-flex min-w-0">
                                <StatusLabel status={status} />
                              </span>
                            </Tooltip>
                          ) : (
                            <StatusLabel status={status} className="text-muted-foreground" />
                          )}
                          <span className={cn('truncate pl-3.5 text-[11px]', isStale(entry) ? 'text-foreground/70' : 'text-muted-foreground')} data-testid="checked">
                            {entry.registry ? (
                              <>
                                checked <RelativeTime iso={entry.registry.checkedAt} />
                              </>
                            ) : (
                              'never checked'
                            )}
                          </span>
                        </span>
                        <span role="cell" className={cn(SHOW.price, 'min-w-0 items-baseline gap-1.5')}>
                          {taken ? (
                            <span className="truncate text-xs text-muted-foreground">{expires ? `Expires ${formatDate(expires)}` : null}</span>
                          ) : best?.firstYear ? (
                            <>
                              <span className="font-semibold tabular">{formatMoney(best.firstYear, best.currency)}</span>
                              {best.firstYearTerm > 1 ? <span className="text-[11px] text-muted-foreground">/{best.firstYearTerm} yr</span> : null}
                              <span className="truncate text-xs text-muted-foreground">{best.providerName}</span>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">Unknown</span>
                          )}
                        </span>
                        <span role="cell" className={cn(SHOW.price, 'justify-end text-muted-foreground tabular')}>
                          {!taken && best?.renewal ? `${formatMoney(best.renewal, best.currency)}${best.renewalTerm > 1 ? ` /${best.renewalTerm} yr` : ''}` : null}
                        </span>
                        <span role="cell" className={cn(SHOW.price, 'justify-end tabular')}>
                          {!taken && best?.horizonTotal ? formatMoney(best.horizonTotal, best.currency) : null}
                        </span>
                        <span role="cell" className={cn(SHOW.notes, 'min-w-0')}>
                          <InlineNotes collectionId={collection.id} entry={entry} />
                        </span>
                        <span role="cell" className="flex items-center justify-end gap-0.5">
                          <span className="@5xl:hidden">
                            <NotesPopover collectionId={collection.id} entry={entry} />
                          </span>
                          {!taken ? (
                            <BuyMenu
                              domain={entry.domain}
                              suffix={suffix}
                              lines={lines}
                              horizon={horizon}
                              open={buyFor === entry.domain}
                              onOpenChange={(o) => setBuyFor(o ? entry.domain : null)}
                              trigger={
                                <Button size="sm" variant={free ? 'secondary' : 'ghost'} className="h-7 px-2" aria-label={`Buy ${entry.domain}`}>
                                  <ShoppingBag />
                                  Buy
                                </Button>
                              }
                            />
                          ) : watched ? (
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground" asChild>
                              <Link href={`/watching/${watches.index.get(entry.domain)!.id}`}>
                                <Eye />
                                Watching
                              </Link>
                            </Button>
                          ) : (
                            <Button size="sm" variant="secondary" className="h-7 px-2" disabled={quickWatch.isPending} onClick={() => quickWatch.mutate(entry.domain)}>
                              <Eye />
                              Watch
                            </Button>
                          )}
                          <Button
                            size="icon-xs"
                            variant="quiet"
                            aria-label={`Remove ${entry.domain}`}
                            className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate([entry.domain])}
                          >
                            <X />
                          </Button>
                        </span>
                      </div>
                      {isOpen ? (
                        <div role="row" className="mb-1 rounded-b-md bg-hover px-3 pb-2">
                          <div role="cell">
                            <ProviderComparison domain={entry.domain} options={options} names={names} />
                          </div>
                        </div>
                      ) : null}
                    </Fragment>
                  );
                })}
              </div>
            </div>
            {entries.hasNextPage ? (
              <div className="flex justify-center py-3">
                <Button variant="ghost" disabled={entries.isFetchingNextPage} onClick={() => entries.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            ) : null}
            {q.trim() && shown.length === 0 ? <EmptyState>No names match.</EmptyState> : null}
          </div>
        )}
      </div>

      <ListNotesDialog key={`${collection.id}-${dialog === 'notes'}`} collection={collection} open={dialog === 'notes'} onOpenChange={(o) => setDialog(o ? 'notes' : null)} />
      <ProviderRequestDialog open={dialog === 'quotes'} onOpenChange={(o) => setDialog(o ? 'quotes' : null)} target={target} />
      <WatchFormDialog open={dialog === 'watch'} onOpenChange={(o) => setDialog(o ? 'watch' : null)} target={target} />
      <ArtifactDialogsHost request={artifact} onClose={() => setArtifact(null)} scopes={scopes} />
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => setDialog(o ? 'delete' : null)}
        title={`Delete ${collection.name}?`}
        description="The list, its notes and names are removed. Retained evidence is kept."
        confirmLabel="Delete list"
        pending={deleteList.isPending}
        onConfirm={() => deleteList.mutate()}
      />
      <ConfirmDialog
        open={dialog === 'remove'}
        onOpenChange={(o) => setDialog(o ? 'remove' : null)}
        title={`Remove ${plural(selected.size, 'name')}?`}
        confirmLabel="Remove"
        pending={remove.isPending}
        onConfirm={() => remove.mutate([...selected])}
      />
    </>
  );
}

export function ListSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-3">
      <Skeleton className="h-8 w-60" />
      <SkeletonRows rows={8} />
    </div>
  );
}
