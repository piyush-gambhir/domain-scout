'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Download, Ellipsis, NotebookPen, Pencil, RotateCw, Scale, Tag, Trash, X } from 'lucide-react';
import { toast } from 'sonner';
import type { CollectionEntry } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { confirmationStatus, registryStatus } from '@/lib/labels';
import { formatCount, plural } from '@/lib/format';
import { lowestRegistrationOffer } from '@/lib/money';
import { qk, useProviders } from '@/lib/queries';
import { useIdempotency } from '@/lib/use-idempotency';
import { isTerminal, useLiveJob } from '@/lib/use-job';
import { useIsWide } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { ArtifactDialogsHost, type ArtifactRequest } from '../actions/artifact-host';
import { ProviderRequestDialog } from '../actions/provider-request-dialog';
import type { DomainTarget, ScopeOption } from '../actions/types';
import { MAX_COMPARE_DOMAINS } from '../compare/shared';
import { useJobStarted } from '../actions/use-job-started';
import { DomainDock, type DomainTab } from '../domain/domain-detail';
import { DomainName } from '../domain/domain-name';
import { Price } from '../domain/price';
import { CheckedAt } from '../domain/time';
import { Crumb, EmptyState, ErrorState, Page, PageHeader } from '../states';
import { StatusLabel } from '../status';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Input, Textarea } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Skeleton, SkeletonRows } from '../ui/skeleton';

const PAGE_SIZE = 200;

function EntryNotes({ collectionId, entry }: { collectionId: string; entry: CollectionEntry }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(entry.notes ?? '');
  const save = useMutation({
    mutationFn: async () =>
      api.call('patchCollectionEntry', { params: { id: collectionId, domain: entry.domain }, body: { notes: notes.trim() || null } }),
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
        if (next) setNotes(entry.notes ?? '');
      }}
    >
      <PopoverTrigger asChild>
        {/* The text shows when the table is wide; narrower, an icon (darker when a note exists) keeps notes editable. */}
        <button
          type="button"
          title={entry.notes ?? undefined}
          className={cn(
            'flex h-control min-w-0 max-w-full items-center gap-1.5 rounded-sm text-left hover:text-foreground',
            entry.notes ? 'text-foreground @5xl:text-muted-foreground' : 'text-muted-foreground',
          )}
          aria-label={entry.notes ? `Edit notes for ${entry.domain}` : `Add notes for ${entry.domain}`}
        >
          {entry.notes ? <span className="hidden truncate @5xl:inline">{entry.notes}</span> : null}
          <NotebookPen aria-hidden className={cn('size-4 shrink-0', entry.notes && '@5xl:hidden')} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Textarea autoFocus aria-label="Notes" value={notes} maxLength={20_000} onChange={(e) => setNotes(e.target.value)} />
          <Button type="submit" size="sm" variant="primary" disabled={save.isPending}>
            Save notes
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function CollectionTitle({ id, name }: { id: string; name: string }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const rename = useMutation({
    mutationFn: async () => (await api.call('patchCollection', { params: { id }, body: { name: value.trim() } })).data,
    onSuccess: (collection) => {
      client.setQueryData(qk.collection(id), collection);
      void client.invalidateQueries({ queryKey: qk.collections });
      setEditing(false);
    },
  });
  if (editing) {
    return (
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim() && value.trim() !== name) rename.mutate();
          else setEditing(false);
        }}
      >
        <Input autoFocus aria-label="Shortlist name" value={value} maxLength={200} onChange={(e) => setValue(e.target.value)} className="w-64 text-base font-semibold" />
        <Button type="submit" size="sm" variant="primary" disabled={rename.isPending}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </form>
    );
  }
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2">
      <span className="truncate">{name}</span>
      <Button
        size="icon-xs"
        variant="quiet"
        aria-label="Rename shortlist"
        onClick={() => {
          setValue(name);
          setEditing(true);
        }}
      >
        <Pencil />
      </Button>
    </span>
  );
}

/** Shortlist notes on one header line; editing opens a popover so the table keeps the height. */
function CollectionNotes({ id, notes }: { id: string; notes: string | null }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(notes ?? '');
  const save = useMutation({
    mutationFn: async () => (await api.call('patchCollection', { params: { id }, body: { notes: value.trim() || null } })).data,
    onSuccess: (collection) => {
      client.setQueryData(qk.collection(id), collection);
      void client.invalidateQueries({ queryKey: qk.collections });
      setOpen(false);
      toast.success('Notes saved');
    },
  });
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setValue(notes ?? '');
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex h-6 min-w-0 max-w-xl items-center gap-1.5 rounded-sm text-left hover:text-foreground">
          <NotebookPen aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{notes ? notes : 'Add notes'}</span>
          {notes ? <span className="sr-only">, edit notes</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <label htmlFor="collection-notes" className="sr-only">
            Notes
          </label>
          <Textarea id="collection-notes" autoFocus placeholder="Notes" value={value} maxLength={20_000} onChange={(e) => setValue(e.target.value)} className="min-h-32" />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" disabled={save.isPending || value === (notes ?? '')}>
              Save notes
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

const thClass = 'h-8 pr-3 text-left text-xs font-medium text-muted-foreground';
const tdClass = 'pr-3 align-middle';

export function CollectionView({ collectionId }: { collectionId: string }) {
  const router = useRouter();
  const client = useQueryClient();
  const searchParams = useSearchParams();
  const isWide = useIsWide();
  const [detailTab, setDetailTab] = useState<DomainTab>('overview');
  const providers = useProviders();
  const started = useJobStarted();
  const idempotency = useIdempotency();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [artifact, setArtifact] = useState<ArtifactRequest | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'remove' | null>(null);
  const detailName = searchParams.get('d');

  const collection = useQuery({
    queryKey: qk.collection(collectionId),
    queryFn: ({ signal }) => api.call('getCollection', { params: { id: collectionId }, signal }).then((r) => r.data),
  });
  const entries = useInfiniteQuery({
    queryKey: qk.collectionEntries(collectionId),
    queryFn: ({ pageParam, signal }) =>
      api.call('listCollectionEntries', { params: { id: collectionId }, query: { cursor: pageParam, limit: PAGE_SIZE }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = entries.data?.pages.flatMap((page) => page.data) ?? [];
  const names = new Map((providers.data ?? []).map((p) => [p.id, p.name]));

  const allDomains = useCallback(async () => {
    const domains: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.call('listCollectionEntries', { params: { id: collectionId }, query: { cursor, limit: 1000 } });
      domains.push(...page.data.map((e) => e.domain));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return domains;
  }, [collectionId]);

  const hasSelection = selected.size > 0;
  const entryCount = collection.data?.entryCount ?? rows.length;
  const target: DomainTarget = {
    count: hasSelection ? selected.size : entryCount,
    resolveDomains: async () => (hasSelection ? [...selected] : allDomains()),
  };
  const scopes: ScopeOption[] = [
    {
      value: 'selection',
      label: `Selected domains (${formatCount(selected.size)})`,
      disabled: !hasSelection,
      build: async () => ({ kind: 'domains', domains: [...selected] }),
    },
    { value: 'collection', label: `Whole shortlist (${formatCount(entryCount)})`, build: async () => ({ kind: 'collection', collectionId }) },
  ];

  const [recheckJobId, setRecheckJobId] = useState<string | null>(null);
  const recheckJob = useLiveJob(recheckJobId);
  const recheckRunning = Boolean(recheckJob.data && !isTerminal(recheckJob.data));
  const recheckDone = isTerminal(recheckJob.data);
  // Refresh entries as the recheck finishes so outcomes and check times update in place.
  useEffect(() => {
    if (recheckJobId && recheckDone) void client.invalidateQueries({ queryKey: qk.collectionEntries(collectionId) });
  }, [client, collectionId, recheckJobId, recheckDone]);

  const recheck = useMutation({
    mutationFn: async () => {
      const body = { domains: await target.resolveDomains(), label: collection.data ? `Recheck ${collection.data.name}` : undefined };
      if (body.domains.length === 0) throw new Error('Nothing to recheck.');
      return (await api.call('createRecheck', { body, idempotencyKey: idempotency.keyFor(body) })).data;
    },
    onSuccess: (job) => {
      idempotency.reset();
      setRecheckJobId(job.id);
      started(job, `Recheck of ${plural(job.counters.total, 'domain')} started`);
    },
  });

  const remove = useMutation({
    mutationFn: async (domains: string[]) => (await api.call('removeCollectionEntries', { params: { id: collectionId }, body: { domains } })).data,
    onSuccess: (result) => {
      toast.success(`Removed ${plural(result.domains.length, 'domain')}`);
      setSelected((current) => {
        const next = new Set(current);
        for (const d of result.domains) next.delete(d);
        return next;
      });
      setConfirm(null);
      void client.invalidateQueries({ queryKey: qk.collectionEntries(collectionId) });
      void client.invalidateQueries({ queryKey: qk.collection(collectionId) });
      void client.invalidateQueries({ queryKey: qk.collections });
    },
  });

  // Comparisons read retained offers only, so opening one sends nothing anywhere.
  const compare = useMutation({
    mutationFn: async () => {
      const domains = await target.resolveDomains();
      if (domains.length === 0) throw new Error('Nothing to compare.');
      if (domains.length > MAX_COMPARE_DOMAINS) throw new Error(`Compare at most ${MAX_COMPARE_DOMAINS} domains at a time.`);
      return domains;
    },
    onSuccess: (domains) => router.push(`/compare?domains=${encodeURIComponent(domains.join(','))}`),
  });

  const deleteCollection = useMutation({
    mutationFn: async () => api.call('deleteCollection', { params: { id: collectionId } }),
    onSuccess: () => {
      toast.success('Shortlist deleted');
      void client.invalidateQueries({ queryKey: qk.collections });
      router.push('/collections');
    },
  });

  const setDetail = useCallback((domain: string | null) => {
    const params = new URLSearchParams(window.location.search);
    if (domain) params.set('d', domain);
    else params.delete('d');
    const query = params.toString();
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
  }, []);
  const closeDetail = useCallback(() => setDetail(null), [setDetail]);
  const open = (domain: string) => (isWide ? setDetail(domain) : router.push(`/domains/${encodeURIComponent(domain)}`));

  if (collection.isPending) {
    return (
      <Page>
        <Skeleton className="h-control w-72" />
        <SkeletonRows rows={10} />
      </Page>
    );
  }
  if (collection.isError) {
    return (
      <Page>
        <PageHeader title="Shortlist" leading={<ShortlistsCrumb />} />
        <ErrorState error={collection.error} onRetry={() => collection.refetch()} />
      </Page>
    );
  }

  const allLoadedSelected = rows.length > 0 && rows.every((r) => selected.has(r.domain));
  const someSelected = rows.some((r) => selected.has(r.domain));
  const countLabel = hasSelection ? formatCount(selected.size) : 'all';

  const panelOpen = Boolean(detailName) && isWide;

  return (
    <div className="flex min-w-0 flex-1 lg:min-h-0">
      <Page>
        <PageHeader
          leading={<ShortlistsCrumb />}
          title={<CollectionTitle key={collection.data.name} id={collectionId} name={collection.data.name} />}
          meta={<span className="font-mono text-muted-foreground tabular">{plural(entryCount, 'domain')}</span>}
          actions={
            <>
              <Button size="sm" variant="secondary" disabled={recheck.isPending || recheckRunning || entryCount === 0} onClick={() => recheck.mutate()}>
                <RotateCw className={cn(recheckRunning && 'motion-safe:animate-spin')} />
                {recheckRunning ? 'Rechecking' : `Recheck ${countLabel}`}
              </Button>
              <Button size="sm" variant="secondary" disabled={entryCount === 0} onClick={() => setQuoteOpen(true)}>
                <Tag />
                Quotes
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setArtifact({ kind: 'export', defaultScope: hasSelection ? 'selection' : 'collection' })}>
                <Download />
                Export
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="secondary" aria-label="More shortlist actions">
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={() => setArtifact({ kind: 'snapshot', defaultScope: hasSelection ? 'selection' : 'collection' })}>
                    <Camera />
                    Snapshot
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={entryCount === 0 || compare.isPending} onSelect={() => compare.mutate()}>
                    <Scale />
                    Compare {hasSelection ? 'selected' : 'all'}
                  </DropdownMenuItem>
                  {hasSelection ? (
                    <DropdownMenuItem onSelect={() => setConfirm('remove')}>
                      <X />
                      Remove selected
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem className="text-negative" onSelect={() => setConfirm('delete')}>
                    <Trash />
                    Delete shortlist
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        >
          <CollectionNotes key={collection.data.notes ?? ''} id={collectionId} notes={collection.data.notes} />
          {hasSelection ? <span className="text-foreground">{formatCount(selected.size)} selected</span> : null}
        </PageHeader>

        {entries.isPending ? (
          <SkeletonRows rows={10} />
        ) : entries.isError ? (
          <ErrorState error={entries.error} onRetry={() => entries.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState>No domains in this shortlist.</EmptyState>
        ) : (
          <div className="@container relative -mx-1 px-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto" data-testid="entries-scroll">
            <table className="w-full table-fixed text-sm">
              <thead className="sticky top-0 z-10 bg-background max-md:top-12">
                <tr>
                  <th scope="col" className={cn(thClass, 'w-9 pl-2')}>
                    <Checkbox
                      aria-label="Select all loaded domains"
                      checked={allLoadedSelected ? true : someSelected ? 'indeterminate' : false}
                      onCheckedChange={(value) => setSelected(value === true ? new Set(rows.map((r) => r.domain)) : new Set())}
                    />
                  </th>
                  <th scope="col" className={thClass}>
                    Domain
                  </th>
                  <th scope="col" className={cn(thClass, 'w-32')}>
                    Registry
                  </th>
                  <th scope="col" className={cn(thClass, 'hidden w-28 @4xl:table-cell')}>
                    Checked
                  </th>
                  <th scope="col" className={cn(thClass, 'hidden w-52 @xl:table-cell')}>
                    Best known price
                  </th>
                  <th scope="col" className={cn(thClass, 'hidden w-44 @3xl:table-cell')}>
                    Provider confirmation
                  </th>
                  <th scope="col" className={cn(thClass, 'w-9 @5xl:w-48')}>
                    <span className="sr-only @5xl:not-sr-only">Notes</span>
                  </th>
                  <th scope="col" className={cn(thClass, 'w-10')}>
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => {
                  const best = lowestRegistrationOffer(entry.offers);
                  const confirmation = [...entry.confirmations].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
                  const isSelected = selected.has(entry.domain);
                  return (
                    <tr key={entry.id} className={cn('h-row transition-colors', isSelected || detailName === entry.domain ? 'bg-selected' : 'hover:bg-hover')}>
                      <td className="rounded-l-md pl-2 align-middle">
                        <Checkbox
                          aria-label={`Select ${entry.unicode || entry.domain}`}
                          checked={isSelected}
                          onCheckedChange={(value) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (value === true) next.add(entry.domain);
                              else next.delete(entry.domain);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className={tdClass}>
                        <button type="button" onClick={() => open(entry.domain)} className="flex min-w-0 max-w-full rounded-sm text-left">
                          <DomainName ascii={entry.domain} unicode={entry.unicode} />
                        </button>
                      </td>
                      <td className={tdClass}>
                        {entry.registry ? <StatusLabel status={registryStatus(entry.registry.outcome)} /> : <span className="text-muted-foreground">Not checked</span>}
                      </td>
                      <td className={cn(tdClass, 'hidden truncate text-muted-foreground @4xl:table-cell')}>
                        {entry.registry ? <CheckedAt iso={entry.registry.checkedAt} freshness={entry.registry.freshness} staleAt={entry.registry.staleAt} /> : null}
                      </td>
                      <td className={cn(tdClass, 'hidden @xl:table-cell')}>
                        {best ? (
                          <span className="flex min-w-0 items-baseline gap-1.5 truncate" title={`${names.get(best.providerId) ?? best.providerId}, ${best.registration.years} year, ${best.source.label}`}>
                            <Price amount={best.registration.amount} currency={best.currency} kind={best.kind} years={best.registration.years} className="shrink-0" />
                            <CheckedAt iso={best.observedAt} freshness={best.freshness} staleAt={best.staleAt} expiresAt={best.quoteExpiresAt} className="truncate text-xs text-muted-foreground" />
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Unknown</span>
                        )}
                      </td>
                      <td className={cn(tdClass, 'hidden @3xl:table-cell')}>
                        {confirmation ? (
                          <span className="flex min-w-0 items-baseline gap-1.5 truncate">
                            <StatusLabel status={confirmationStatus(confirmation.status)} />
                            <span className="truncate text-xs text-muted-foreground">{names.get(confirmation.providerId) ?? confirmation.providerId}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">None</span>
                        )}
                      </td>
                      <td className={tdClass}>
                        <EntryNotes collectionId={collectionId} entry={entry} />
                      </td>
                      <td className="rounded-r-md pr-1 text-right align-middle">
                        <Button size="icon-xs" variant="quiet" aria-label={`Remove ${entry.domain}`} disabled={remove.isPending} onClick={() => remove.mutate([entry.domain])}>
                          <X />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {entries.hasNextPage ? (
              <div className="flex justify-center py-3">
                <Button variant="ghost" disabled={entries.isFetchingNextPage} onClick={() => entries.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </Page>

      {panelOpen && detailName ? <DomainDock name={detailName} tab={detailTab} onTab={setDetailTab} onClose={closeDetail} /> : null}
      <ProviderRequestDialog open={quoteOpen} onOpenChange={setQuoteOpen} target={target} />
      <ArtifactDialogsHost request={artifact} onClose={() => setArtifact(null)} scopes={scopes} />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={`Delete ${collection.data.name}?`}
        description="The shortlist, its notes and entries are removed. Retained evidence is kept."
        confirmLabel="Delete shortlist"
        pending={deleteCollection.isPending}
        onConfirm={() => deleteCollection.mutate()}
      />
      <ConfirmDialog
        open={confirm === 'remove'}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={`Remove ${plural(selected.size, 'domain')}?`}
        confirmLabel="Remove"
        pending={remove.isPending}
        onConfirm={() => remove.mutate([...selected])}
      />
    </div>
  );
}

function ShortlistsCrumb() {
  return (
    <Crumb>
      <Link href="/collections" className="rounded-sm hover:text-foreground">
        Shortlists
      </Link>
    </Crumb>
  );
}
