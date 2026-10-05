'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, RotateCcw, Trash } from 'lucide-react';
import { toast } from 'sonner';
import type { SavedCriteria } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { formatMoney, plural } from '@/lib/format';
import { qk, useCollections, useCriteria } from '@/lib/queries';
import { RelativeTime } from '../domain/time';
import { EmptyState, ErrorState, PageHeader, SectionTitle } from '../states';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter } from '../ui/dialog';
import { Input, Textarea } from '../ui/input';
import { Field } from '../ui/label';
import { SkeletonRows } from '../ui/skeleton';

function CreateCollectionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const create = useMutation({
    mutationFn: async () => (await api.call('createCollection', { body: { name: name.trim(), notes: notes.trim() || undefined } })).data,
    onSuccess: (collection) => {
      void client.invalidateQueries({ queryKey: qk.collections });
      setName('');
      setNotes('');
      onOpenChange(false);
      router.push(`/collections/${collection.id}`);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New shortlist">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Field label="Name" htmlFor="new-collection-name">
            <Input id="new-collection-name" autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Notes" htmlFor="new-collection-notes">
            <Textarea id="new-collection-notes" value={notes} maxLength={20_000} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <DialogFooter className="mt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CriteriaRow({ criteria, onDelete }: { criteria: SavedCriteria; onDelete: () => void }) {
  const router = useRouter();
  const target = criteria.generation ? `/discover?criteria=${criteria.id}` : `/scan?criteria=${criteria.id}`;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-lg px-3 py-3 hover:bg-hover">
      <div className="min-w-0">
        <p className="truncate font-medium">{criteria.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {criteria.extensions.length ? <span className="font-mono">{criteria.extensions.map((e) => `.${e}`).join(' ')}</span> : 'No extensions'}
          {criteria.providerIds.length ? ` · ${plural(criteria.providerIds.length, 'provider')}` : ''}
          {criteria.budget ? ` · budget ${formatMoney(criteria.budget.amount, criteria.budget.currency)}` : ''}
          {criteria.generation ? ' · generation rules' : ''}
          {' · '}
          <RelativeTime iso={criteria.updatedAt} />
        </p>
      </div>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="secondary" onClick={() => router.push(target)}>
          <RotateCcw />
          Restore
        </Button>
        <Button size="icon-sm" variant="quiet" aria-label={`Delete ${criteria.name}`} onClick={onDelete}>
          <Trash />
        </Button>
      </div>
    </li>
  );
}

export function CollectionsPage() {
  const client = useQueryClient();
  const collections = useCollections();
  const criteria = useCriteria();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<SavedCriteria | null>(null);

  const deleteCriteria = useMutation({
    mutationFn: async (id: string) => api.call('deleteCriteria', { params: { id } }),
    onSuccess: () => {
      toast.success('Criteria deleted');
      setDeleting(null);
      void client.invalidateQueries({ queryKey: qk.criteria });
    },
  });

  return (
    <>
      <PageHeader
        title="Shortlists"
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus />
            New shortlist
          </Button>
        }
      />
      {collections.isPending ? (
        <SkeletonRows rows={5} />
      ) : collections.isError ? (
        <ErrorState error={collections.error} onRetry={() => collections.refetch()} />
      ) : collections.data.length === 0 ? (
        <EmptyState>No shortlists yet.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-0.5" aria-label="Shortlists">
          {collections.data.map((collection) => (
            <li key={collection.id}>
              <Link
                href={`/collections/${collection.id}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 rounded-lg px-3 py-3 transition-colors hover:bg-hover"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{collection.name}</span>
                  {collection.notes ? <span className="block truncate text-xs text-muted-foreground">{collection.notes}</span> : null}
                </span>
                <span className="text-right text-xs text-muted-foreground">
                  <span className="block font-mono tabular">{plural(collection.entryCount, 'domain')}</span>
                  <RelativeTime iso={collection.updatedAt} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <section className="mt-12" aria-label="Saved criteria">
        <SectionTitle>Saved criteria</SectionTitle>
        {criteria.isPending ? (
          <SkeletonRows rows={3} />
        ) : criteria.isError ? (
          <ErrorState error={criteria.error} onRetry={() => criteria.refetch()} />
        ) : criteria.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No saved criteria.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {criteria.data.map((item) => (
              <CriteriaRow key={item.id} criteria={item} onDelete={() => setDeleting(item)} />
            ))}
          </ul>
        )}
      </section>

      <CreateCollectionDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'criteria'}?`}
        confirmLabel="Delete"
        pending={deleteCriteria.isPending}
        onConfirm={() => deleting && deleteCriteria.mutate(deleting.id)}
      />
    </>
  );
}
