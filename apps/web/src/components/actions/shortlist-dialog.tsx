'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RadioGroup } from 'radix-ui';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { plural } from '@/lib/format';
import { qk, useCollections } from '@/lib/queries';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter } from '../ui/dialog';
import { Input } from '../ui/input';
import { SkeletonRows } from '../ui/skeleton';
import type { DomainTarget } from './types';

const NEW = '__new__';

const optionClass =
  'flex min-h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition-colors hover:bg-hover data-[state=checked]:bg-selected data-[state=checked]:font-medium';

export function ShortlistDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: DomainTarget;
}) {
  const client = useQueryClient();
  const collections = useCollections(open);
  const [choice, setChoice] = useState<string>('');
  const [name, setName] = useState('');
  const effectiveChoice = choice || (collections.data?.[0]?.id ?? NEW);

  const mutation = useMutation({
    mutationFn: async () => {
      const domains = await target.resolveDomains();
      if (domains.length === 0) throw new Error('Nothing selected.');
      let id = effectiveChoice;
      let listName = collections.data?.find((c) => c.id === id)?.name ?? '';
      if (id === NEW) {
        const created = await api.call('createCollection', { body: { name: name.trim() } });
        id = created.data.id;
        listName = created.data.name;
      }
      const result = await api.call('addCollectionEntries', { params: { id }, body: { domains } });
      return { ...result.data, id, listName };
    },
    onSuccess: (result) => {
      const extra = [
        result.existing ? `${result.existing} already there` : null,
        result.rejected.length ? `${result.rejected.length} rejected` : null,
      ].filter(Boolean);
      toast.success(`Added ${plural(result.added, 'domain')} to ${result.listName}${extra.length ? ` (${extra.join(', ')})` : ''}`);
      void client.invalidateQueries({ queryKey: qk.collections });
      void client.invalidateQueries({ queryKey: qk.collectionEntries(result.id) });
      void client.invalidateQueries({ queryKey: ['jobResults'] });
      void client.invalidateQueries({ queryKey: ['evidence'] });
      setName('');
      onOpenChange(false);
    },
  });

  const canSubmit = effectiveChoice !== NEW || name.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Add ${plural(target.count, 'domain')} to a shortlist`}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) mutation.mutate();
          }}
        >
          {collections.isPending ? (
            <SkeletonRows rows={3} />
          ) : (
            <RadioGroup.Root value={effectiveChoice} onValueChange={setChoice} aria-label="Shortlist" className="flex flex-col gap-0.5">
              {(collections.data ?? []).map((collection) => (
                <RadioGroup.Item key={collection.id} value={collection.id} className={optionClass}>
                  <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                  <span className="font-mono text-xs text-muted-foreground tabular">{collection.entryCount}</span>
                </RadioGroup.Item>
              ))}
              <RadioGroup.Item value={NEW} className={optionClass}>
                New shortlist
              </RadioGroup.Item>
            </RadioGroup.Root>
          )}
          {effectiveChoice === NEW ? (
            <Input
              autoFocus
              aria-label="Shortlist name"
              placeholder="Name"
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
              className="mt-3"
            />
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!canSubmit || mutation.isPending}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
