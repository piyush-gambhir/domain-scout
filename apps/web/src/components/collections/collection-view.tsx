'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { useIsDesktop } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { ArtifactDialogsHost, type ArtifactRequest } from '../actions/artifact-host';
import { ProviderRequestDialog } from '../actions/provider-request-dialog';
import type { DomainTarget, ScopeOption } from '../actions/types';
import { MAX_COMPARE_DOMAINS } from '../compare/shared';
import { useJobStarted } from '../actions/use-job-started';
import { DomainDetail } from '../domain/domain-detail';
import { DomainName } from '../domain/domain-name';
import { Price } from '../domain/price';
import { CheckedAt } from '../domain/time';
import { EmptyState, ErrorState, PageHeader } from '../states';
import { StatusLabel } from '../status';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Input, Textarea } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Sheet } from '../ui/sheet';
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
        <button
          type="button"
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-sm text-left text-muted-foreground hover:text-foreground"
          aria-label={entry.notes ? `Edit notes for ${entry.domain}` : `Add notes for ${entry.domain}`}
        >
          {entry.notes ? <span className="truncate">{entry.notes}</span> : <NotebookPen className="size-4" />}
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
        <Input autoFocus aria-label="Shortlist name" value={value} maxLength={200} onChange={(e) => setValue(e.target.value)} className="h-9 w-72 text-base font-semibold" />
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
    <span className="inline-flex items-center gap-2">
      {name}
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

function CollectionNotes({ id, notes }: { id: string; notes: string | null }) {
  const client = useQueryClient();
  const [value, setValue] = useState(notes ?? '');
  const dirty = value !== (notes ?? '');
  const save = useMutation({
    mutationFn: async () => (await api.call('patchCollection', { params: { id }, body: { notes: value.trim() || null } })).data,
    onSuccess: (collection) => {
      client.setQueryData(qk.collection(id), collection);
      void client.invalidateQueries({ queryKey: qk.collections });
      toast.success('Notes saved');
    },
  });
  return (
    <div className="flex max-w-2xl flex-col gap-2">
      <label htmlFor="collection-notes" className="sr-only">
        Notes
      </label>
      <Textarea id="collection-notes" placeholder="Notes" value={value} maxLength={20_000} onChange={(e) => setValue(e.target.value)} className="min-h-16" />
      {dirty ? (
        <div className="flex gap-2">
          <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
            Save notes
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setValue(notes ?? '')}>
            Discard
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function CollectionView({ collectionId }: { collectionId: string }) {
  const router = useRouter();
  const client = useQueryClient();
  const searchParams = useSearchParams();
  const isDesktop = useIsDesktop();
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

  const setDetail = (domain: string | null) => {
    const params = new URLSearchParams(window.location.search);
    if (domain) params.set('d', domain);
    else params.delete('d');
    const query = params.toString();
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
  };
  const open = (domain: string) => (isDesktop ? setDetail(domain) : router.push(`/domains/${encodeURIComponent(domain)}`));

  if (collection.isPending) {
    return (
      <>
        <Skeleton className="mb-6 h-7 w-56" />
        <SkeletonRows rows={8} />
      </>
    );
  }
  if (collection.isError) {
    return (
      <>
        <PageHeader title="Shortlist" />
        <ErrorState error={collection.error} onRetry={() => collection.refetch()} />
      </>
    );
  }

  const allLoadedSelected = rows.length > 0 && rows.every((r) => selected.has(r.domain));
  const someSelected = rows.some((r) => selected.has(r.domain));
  const countLabel = hasSelection ? formatCount(selected.size) : 'all';

  return (
    <>
      <PageHeader
        title={<CollectionTitle key={collection.data.name} id={collectionId} name={collection.data.name} />}
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
        <p className="text-sm text-muted-foreground">{plural(entryCount, 'domain')}</p>
      </PageHeader>

      <CollectionNotes key={collection.data.notes ?? ''} id={collectionId} notes={collection.data.notes} />

      <div className="mt-8">
        {entries.isPending ? (
          <SkeletonRows rows={8} />
        ) : entries.isError ? (
          <ErrorState error={entries.error} onRetry={() => entries.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState>No domains in this shortlist.</EmptyState>
        ) : (
          <div className="relative -mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th scope="col" className="w-10 pb-2 pl-2 font-medium">
                    <Checkbox
                      aria-label="Select all loaded domains"
                      checked={allLoadedSelected ? true : someSelected ? 'indeterminate' : false}
                      onCheckedChange={(value) => setSelected(value === true ? new Set(rows.map((r) => r.domain)) : new Set())}
                    />
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    Domain
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    Registry
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    Checked
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    Best known price
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    Provider confirmation
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    Notes
                  </th>
                  <th scope="col" className="w-10 pb-2 font-medium">
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
                    <tr
                      key={entry.id}
                      className={cn('transition-colors', isSelected || detailName === entry.domain ? 'bg-selected' : 'hover:bg-hover')}
                    >
                      <td className="rounded-l-md py-2.5 pl-2">
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
                      <td className="max-w-64 py-2.5 pr-4">
                        <button type="button" onClick={() => open(entry.domain)} className="flex min-w-0 max-w-full rounded-sm text-left">
                          <DomainName ascii={entry.domain} unicode={entry.unicode} className="text-[13px]" />
                        </button>
                      </td>
                      <td className="py-2.5 pr-4">
                        {entry.registry ? (
                          <StatusLabel status={registryStatus(entry.registry.outcome)} />
                        ) : (
                          <span className="text-muted-foreground">Not checked</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-muted-foreground">
                        {entry.registry ? (
                          <CheckedAt iso={entry.registry.checkedAt} freshness={entry.registry.freshness} staleAt={entry.registry.staleAt} />
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-4">
                        {best ? (
                          <span className="flex flex-col">
                            <Price amount={best.registration.amount} currency={best.currency} kind={best.kind} years={best.registration.years} />
                            <span className="text-xs text-muted-foreground">
                              {names.get(best.providerId) ?? best.providerId} ·{' '}
                              <CheckedAt iso={best.observedAt} freshness={best.freshness} staleAt={best.staleAt} expiresAt={best.quoteExpiresAt} />
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Unknown</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4">
                        {confirmation ? (
                          <span className="flex flex-col">
                            <StatusLabel status={confirmationStatus(confirmation.status)} />
                            <span className="text-xs text-muted-foreground">{names.get(confirmation.providerId) ?? confirmation.providerId}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">None</span>
                        )}
                      </td>
                      <td className="max-w-56 py-2.5 pr-4">
                        <EntryNotes collectionId={collectionId} entry={entry} />
                      </td>
                      <td className="rounded-r-md py-2.5 pr-2">
                        <Button
                          size="icon-xs"
                          variant="quiet"
                          aria-label={`Remove ${entry.domain}`}
                          disabled={remove.isPending}
                          onClick={() => remove.mutate([entry.domain])}
                        >
                          <X />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {entries.hasNextPage ? (
          <div className="mt-4 flex justify-center">
            <Button variant="ghost" disabled={entries.isFetchingNextPage} onClick={() => entries.fetchNextPage()}>
              Load more
            </Button>
          </div>
        ) : null}
      </div>

      <Sheet open={Boolean(detailName) && isDesktop} onOpenChange={(next) => !next && setDetail(null)} title={detailName ?? ''}>
        {detailName ? <DomainDetail key={detailName} name={detailName} variant="panel" /> : null}
      </Sheet>
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
    </>
  );
}
