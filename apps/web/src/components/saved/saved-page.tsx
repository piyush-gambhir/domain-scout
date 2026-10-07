'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RotateCcw, Trash } from 'lucide-react';
import { toast } from 'sonner';
import type { Collection, SavedCriteria } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { qk, useCollections, useCriteria } from '@/lib/queries';
import { defaultListOf } from '@/lib/saved';
import { useIsWide } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { Portfolio } from './owned';
import { DomainDock } from '../domain/domain-panel';
import { ErrorState, Page } from '../states';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { SkeletonRows } from '../ui/skeleton';
import { ListSkeleton, ListView } from './list-view';

const itemClass =
  'focus-inset group/item flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground aria-[current=page]:bg-selected aria-[current=page]:font-medium aria-[current=page]:text-foreground';

function NewList({ onCreated }: { onCreated: (collection: Collection) => void }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: async () => (await api.call('createCollection', { body: { name: name.trim() } })).data,
    onSuccess: (collection) => {
      void client.invalidateQueries({ queryKey: qk.collections });
      setName('');
      setOpen(false);
      onCreated(collection);
    },
  });
  if (!open) {
    return (
      <button type="button" className={itemClass} onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        New list
      </button>
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) create.mutate();
      }}
    >
      <Input
        autoFocus
        aria-label="New list name"
        placeholder="List name"
        value={name}
        maxLength={200}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => !name.trim() && setOpen(false)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      />
    </form>
  );
}

function SavedSearch({ criteria, onDelete }: { criteria: SavedCriteria; onDelete: () => void }) {
  const href = criteria.generation ? `/?mode=ideas&criteria=${criteria.id}` : `/?criteria=${criteria.id}`;
  const meta = [
    criteria.extensions.length ? criteria.extensions.map((e) => `.${e}`).join(' ') : null,
    criteria.budget ? `up to ${formatMoney(criteria.budget.amount, criteria.budget.currency)}` : null,
    criteria.generation ? 'ideas' : null,
  ].filter(Boolean);
  return (
    <li className="group/item relative">
      <Link href={href} className={cn(itemClass, 'h-auto min-h-8 flex-col items-start gap-0 py-1.5 pr-8')} title="Restore this search">
        <span className="flex w-full items-center gap-2 truncate text-foreground">
          <RotateCcw className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{criteria.name}</span>
        </span>
        {meta.length ? <span className="w-full truncate pl-5.5 font-mono text-[11px]">{meta.join(' · ')}</span> : null}
      </Link>
      <button
        type="button"
        aria-label={`Delete ${criteria.name}`}
        onClick={onDelete}
        className="absolute right-1 top-1.5 grid size-6 place-items-center rounded text-muted-foreground opacity-0 transition hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover/item:opacity-100"
      >
        <Trash className="size-3.5" />
      </button>
    </li>
  );
}

/** Lists, the owned-domains view and saved searches, one click each. */
function Switcher({ collections, activeId, owned }: { collections: Collection[]; activeId: string | null; owned: boolean }) {
  const router = useRouter();
  const client = useQueryClient();
  const criteria = useCriteria();
  const [deleting, setDeleting] = useState<SavedCriteria | null>(null);
  const remove = useMutation({
    mutationFn: async (id: string) => api.call('deleteCriteria', { params: { id } }),
    onSuccess: () => {
      toast.success('Saved search deleted');
      setDeleting(null);
      void client.invalidateQueries({ queryKey: qk.criteria });
    },
  });
  return (
    <nav aria-label="Saved lists" className="relative -mx-1 flex shrink-0 flex-col gap-5 px-1 lg:min-h-0 lg:w-56 lg:overflow-y-auto">
      <div>
        <p className="mb-1 px-2.5 text-xs font-medium text-muted-foreground">Lists</p>
        <ul className="flex flex-col gap-0.5">
          {collections.map((collection) => (
            <li key={collection.id}>
              <Link href={`/saved/${collection.id}`} aria-current={collection.id === activeId ? 'page' : undefined} className={itemClass}>
                <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                <span className="text-xs tabular">{collection.entryCount}</span>
              </Link>
            </li>
          ))}
          <li>
            <NewList onCreated={(c) => router.push(`/saved/${c.id}`)} />
          </li>
        </ul>
      </div>
      <div>
        <p className="mb-1 px-2.5 text-xs font-medium text-muted-foreground">Owned</p>
        <Link href="/saved/owned" aria-current={owned ? 'page' : undefined} className={itemClass}>
          Domains you own
        </Link>
      </div>
      {criteria.data?.length ? (
        <div>
          <p className="mb-1 px-2.5 text-xs font-medium text-muted-foreground">Searches</p>
          <ul className="flex flex-col gap-0.5" aria-label="Saved searches">
            {criteria.data.map((item) => (
              <SavedSearch key={item.id} criteria={item} onDelete={() => setDeleting(item)} />
            ))}
          </ul>
        </div>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'saved search'}?`}
        confirmLabel="Delete"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </nav>
  );
}

/**
 * The decision workspace. /saved opens the default list, /saved/[id] a list, /saved/owned the
 * domains you already own.
 */
export function SavedPage({ listId, owned = false }: { listId?: string; owned?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isWide = useIsWide();
  const collections = useCollections();
  const list = useQuery({
    queryKey: qk.collection(listId ?? ''),
    queryFn: ({ signal }) => api.call('getCollection', { params: { id: listId! }, signal }).then((r) => r.data),
    enabled: Boolean(listId),
  });
  const fallback = defaultListOf(collections.data) ?? collections.data?.[0] ?? null;
  const active = owned ? null : listId ? (list.data ?? collections.data?.find((c) => c.id === listId) ?? null) : fallback;
  const detail = searchParams.get('d');
  const panelOpen = Boolean(detail) && isWide && !owned;
  const closeDetail = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete('d');
    const query = params.toString();
    window.history.replaceState(null, '', query ? `?${query}` : pathname);
  };

  let main: React.ReactNode;
  if (owned) main = <Portfolio />;
  else if (collections.isPending || (listId && list.isPending)) main = <ListSkeleton />;
  else if (collections.isError) main = <ErrorState error={collections.error} onRetry={() => collections.refetch()} />;
  else if (listId && list.isError) main = <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  else if (!active) {
    main = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12">
        <p className="text-sm text-muted-foreground">Nothing saved yet.</p>
        <Button size="sm" variant="primary" asChild>
          <Link href="/">Search</Link>
        </Button>
      </div>
    );
  } else main = <ListView key={active.id} collection={active} onDeleted={() => router.push('/saved')} />;

  return (
    <div className="flex min-w-0 flex-1 lg:min-h-0">
      <Page>
        <h1 className="sr-only">Saved</h1>
        <div className="flex flex-col gap-6 lg:min-h-0 lg:flex-1 lg:flex-row lg:gap-8">
          {collections.isPending ? (
            <div className="lg:w-56">
              <SkeletonRows rows={4} />
            </div>
          ) : (
            <Switcher collections={collections.data ?? []} activeId={active?.id ?? null} owned={owned} />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-3 lg:min-h-0">{main}</div>
        </div>
      </Page>
      {panelOpen && detail ? <DomainDock name={detail} onClose={closeDetail} /> : null}
    </div>
  );
}

