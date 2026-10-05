'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash } from 'lucide-react';
import { toast } from 'sonner';
import type { DataCategory } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { formatBytes, formatCount, formatDate, plural } from '@/lib/format';
import { qk, useCollections } from '@/lib/queries';
import { ErrorState, Facts, SectionTitle } from '../states';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Field } from '../ui/label';
import { Skeleton } from '../ui/skeleton';

export const CATEGORY_LABEL: Record<DataCategory, string> = {
  jobs: 'Jobs and results',
  registry_evidence: 'Registry evidence',
  provider_evidence: 'Provider confirmations',
  price_history: 'Prices and price history',
  name_checks: 'Name checks',
  diagnostics: 'Diagnostics',
  raw_diagnostics: 'Raw registry responses',
  collections: 'Shortlists',
  criteria: 'Saved criteria',
  watches: 'Watches and notices',
  portfolio: 'Portfolio',
  artifacts: 'Exports and snapshots',
};

const rowClass = 'flex min-h-9 items-center gap-3 rounded-md px-2 text-sm hover:bg-hover';

export function DataSettings() {
  const client = useQueryClient();
  const inventory = useQuery({
    queryKey: qk.dataInventory,
    queryFn: ({ signal }) => api.call('getDataInventory', { signal }).then((r) => r.data),
  });
  const collections = useCollections();
  const [categories, setCategories] = useState<Set<DataCategory>>(new Set());
  const [collectionIds, setCollectionIds] = useState<Set<string>>(new Set());
  const [before, setBefore] = useState('');
  const [confirming, setConfirming] = useState(false);

  const counts = new Map((inventory.data?.categories ?? []).map((c) => [c.category, c.count]));
  const chosen = (inventory.data?.categories ?? []).map((c) => c.category).filter((c) => categories.has(c));
  const beforeIso = before ? new Date(`${before}T00:00:00`).toISOString() : undefined;
  const limitCollections = categories.has('collections') && collectionIds.size > 0;
  const chosenCollections = (collections.data ?? []).filter((c) => collectionIds.has(c.id));

  const remove = useMutation({
    mutationFn: async () =>
      (
        await api.call('deleteData', {
          body: { categories: chosen, collectionIds: limitCollections ? [...collectionIds] : undefined, before: beforeIso },
        })
      ).data,
    onSuccess: (result) => {
      setConfirming(false);
      setCategories(new Set());
      setCollectionIds(new Set());
      const total = result.deleted.reduce((sum, d) => sum + d.count, 0);
      toast.success(`Deleted ${plural(total, 'record')}`);
      // Deletion can touch any view; refetch everything.
      void client.invalidateQueries();
    },
  });

  const toggle = <T,>(set: Set<T>, value: T, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  };

  return (
    <section aria-label="Data">
      <SectionTitle>Data</SectionTitle>
      {inventory.isPending ? (
        <Skeleton className="h-64 max-w-2xl" />
      ) : inventory.isError ? (
        <ErrorState error={inventory.error} onRetry={() => inventory.refetch()} />
      ) : (
        <div className="flex max-w-2xl flex-col gap-10">
          <Facts
            items={[
              ['Location', <span key="d" className="break-all font-mono text-[13px]">{inventory.data.dataDir}</span>],
              ['Database', formatBytes(inventory.data.databaseBytes)],
            ]}
          />

          <fieldset>
            <legend className="mb-2 text-xs font-medium text-muted-foreground">Delete local data</legend>
            <ul className="grid gap-0.5 sm:grid-cols-2" aria-label="Categories">
              {inventory.data.categories.map(({ category, count }) => (
                <li key={category}>
                  <label htmlFor={`del-${category}`} className={rowClass}>
                    <Checkbox
                      id={`del-${category}`}
                      checked={categories.has(category)}
                      onCheckedChange={(v) => setCategories((set) => toggle(set, category, v === true))}
                    />
                    <span className="flex-1">{CATEGORY_LABEL[category] ?? category}</span>
                    <span className="font-mono text-xs text-muted-foreground tabular">{formatCount(count)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          {categories.has('collections') && (collections.data?.length ?? 0) > 0 ? (
            <fieldset>
              <legend className="mb-2 text-xs font-medium text-muted-foreground">Only these shortlists</legend>
              <ul className="grid gap-0.5 sm:grid-cols-2" aria-label="Shortlists to delete">
                {collections.data!.map((collection) => (
                  <li key={collection.id}>
                    <label htmlFor={`del-c-${collection.id}`} className={rowClass}>
                      <Checkbox
                        id={`del-c-${collection.id}`}
                        checked={collectionIds.has(collection.id)}
                        onCheckedChange={(v) => setCollectionIds((set) => toggle(set, collection.id, v === true))}
                      />
                      <span className="flex-1 truncate">{collection.name}</span>
                      <span className="font-mono text-xs text-muted-foreground tabular">{formatCount(collection.entryCount)}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="mt-1 px-2 text-xs text-muted-foreground">{collectionIds.size ? plural(collectionIds.size, 'shortlist') : 'All shortlists'}</p>
            </fieldset>
          ) : null}

          <Field label="Only records from before" htmlFor="del-before" className="max-w-56">
            <Input id="del-before" type="date" value={before} onChange={(e) => setBefore(e.target.value)} />
          </Field>

          <div>
            <Button variant="danger" disabled={chosen.length === 0} onClick={() => setConfirming(true)}>
              <Trash />
              Delete selected data
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete local data?"
        description={beforeIso ? `Only records from before ${formatDate(beforeIso)} are removed. This cannot be undone.` : 'This cannot be undone.'}
        confirmLabel="Delete"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      >
        <ul className="flex flex-col gap-1" data-testid="delete-summary">
          {chosen.map((category) => (
            <li key={category} className="flex justify-between gap-4">
              <span>
                {CATEGORY_LABEL[category] ?? category}
                {category === 'collections' && limitCollections ? `: ${chosenCollections.map((c) => c.name).join(', ')}` : ''}
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground tabular">
                {category === 'collections' && limitCollections
                  ? plural(chosenCollections.length, 'shortlist')
                  : beforeIso
                    ? `up to ${formatCount(counts.get(category) ?? 0)}`
                    : formatCount(counts.get(category) ?? 0)}
              </span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </section>
  );
}
