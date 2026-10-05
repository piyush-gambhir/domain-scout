'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { plural } from '@/lib/format';
import { useProviders } from '@/lib/queries';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogFooter } from '../ui/dialog';
import { Input } from '../ui/input';
import { Field } from '../ui/label';
import { Select } from '../ui/select';
import { SwitchField } from '../ui/switch';
import { Disclosure, joinNames } from './disclosure';
import type { DomainTarget } from './types';

const INTERVALS = [
  { value: '60', label: 'Hourly' },
  { value: '360', label: 'Every 6 hours' },
  { value: '1440', label: 'Daily' },
  { value: '10080', label: 'Weekly' },
];

const MAX_WATCH_DOMAINS = 5000;

export function WatchDialog({ open, onOpenChange, target }: { open: boolean; onOpenChange: (open: boolean) => void; target: DomainTarget }) {
  const router = useRouter();
  const client = useQueryClient();
  const providers = useProviders();
  const [name, setName] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState('1440');
  const [includeRegistry, setIncludeRegistry] = useState(true);
  const [includeCatalogPrices, setIncludeCatalogPrices] = useState(false);
  const [providerIds, setProviderIds] = useState<Set<string>>(new Set());

  const eligible = (providers.data ?? []).filter(
    (p) =>
      p.enabled &&
      (p.capabilities.exactCheck.level !== 'unsupported' || p.capabilities.quote.level !== 'unsupported') &&
      !(p.capabilities.exactCheck.requiresCredentials && p.capabilities.quote.requiresCredentials && !p.credentials.configured),
  );
  const chosen = eligible.filter((p) => providerIds.has(p.id));
  const destinations = [includeRegistry ? 'registry services' : null, ...chosen.map((p) => p.name)].filter((d): d is string => Boolean(d));

  const mutation = useMutation({
    mutationFn: async () => {
      const domains = await target.resolveDomains();
      if (domains.length === 0) throw new Error('Nothing selected.');
      if (domains.length > MAX_WATCH_DOMAINS) throw new Error(`A watch holds at most ${MAX_WATCH_DOMAINS} domains.`);
      const response = await api.call('createWatch', {
        body: {
          name: name.trim() || `Watch of ${plural(domains.length, 'domain')}`,
          domains,
          includeRegistry,
          providerIds: chosen.map((p) => p.id),
          includeCatalogPrices,
          intervalMinutes: Number(intervalMinutes),
        },
      });
      return response.data;
    },
    onSuccess: (watch) => {
      void client.invalidateQueries({ queryKey: ['watches'] });
      toast.success(`Watching ${plural(watch.domains.length, 'domain')}`, {
        action: { label: 'Open', onClick: () => router.push('/monitoring') },
      });
      onOpenChange(false);
    },
  });

  const nothingToCheck = !includeRegistry && chosen.length === 0 && !includeCatalogPrices;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Watch ${plural(target.count, 'domain')}`}>
        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor="watch-name">
            <Input id="watch-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Interval" htmlFor="watch-interval">
            <Select id="watch-interval" value={intervalMinutes} onValueChange={setIntervalMinutes} options={INTERVALS} />
          </Field>
          <SwitchField id="watch-registry" label="Registry evidence" checked={includeRegistry} onCheckedChange={setIncludeRegistry} />
          <SwitchField id="watch-catalog" label="Published prices" checked={includeCatalogPrices} onCheckedChange={setIncludeCatalogPrices} />
          {eligible.length > 0 ? (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Provider checks and quotes</p>
              <ul className="flex flex-col gap-0.5">
                {eligible.map((provider) => (
                  <li key={provider.id}>
                    <label htmlFor={`watch-p-${provider.id}`} className="flex min-h-9 items-center gap-3 rounded-md px-2 text-sm hover:bg-hover">
                      <Checkbox
                        id={`watch-p-${provider.id}`}
                        checked={providerIds.has(provider.id)}
                        onCheckedChange={(value) =>
                          setProviderIds((current) => {
                            const next = new Set(current);
                            if (value === true) next.add(provider.id);
                            else next.delete(provider.id);
                            return next;
                          })
                        }
                      />
                      {provider.name}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        {destinations.length > 0 ? (
          <Disclosure>
            Each run sends {plural(target.count, 'domain name')} to {joinNames(destinations)}. Runs happen while the local backend is running.
          </Disclosure>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={nothingToCheck || mutation.isPending} onClick={() => mutation.mutate()}>
            Create watch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
