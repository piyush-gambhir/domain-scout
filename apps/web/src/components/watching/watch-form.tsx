'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Provider, Watch } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { parseDomains } from '@/lib/domains';
import { formatInterval, plural } from '@/lib/format';
import { qk, useProviders, useSettings } from '@/lib/queries';
import { Disclosure, joinNames } from '../actions/disclosure';
import type { DomainTarget } from '../actions/types';
import { ErrorState } from '../states';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogFooter } from '../ui/dialog';
import { Input, Textarea } from '../ui/input';
import { Field } from '../ui/label';
import { Select } from '../ui/select';
import { SkeletonRows } from '../ui/skeleton';
import { SwitchField } from '../ui/switch';

const INTERVALS = [15, 60, 360, 720, 1440, 10080];
export const MAX_WATCH_DOMAINS = 5000;

/** Providers that can confirm or quote exact names now (enabled, supported, credentials present when required). */
function eligibleProviders(providers: Provider[], keep: string[]): Provider[] {
  return providers.filter(
    (p) =>
      keep.includes(p.id) ||
      (p.enabled &&
        (p.capabilities.exactCheck.level !== 'unsupported' || p.capabilities.quote.level !== 'unsupported') &&
        !(p.capabilities.exactCheck.requiresCredentials && p.capabilities.quote.requiresCredentials && !p.credentials.configured)),
  );
}

/** "Porkbun (api.porkbun.com)": the provider and the hosts that receive names. */
function providerDestination(provider: Provider): string {
  return provider.apiHosts.length ? `${provider.name} (${provider.apiHosts.join(', ')})` : provider.name;
}

interface WatchFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this watch; otherwise create one. */
  watch?: Watch;
  /** Create from a selection (results, shortlists); otherwise domains are typed in. */
  target?: DomainTarget;
}

/** Inner body, mounted per opening so the draft starts from the watch or the defaults. */
function WatchFormBody({ onOpenChange, watch, target }: Omit<WatchFormProps, 'open'>) {
  const router = useRouter();
  const client = useQueryClient();
  const providers = useProviders();
  const settings = useSettings();
  const defaultInterval = settings.data?.monitoring.defaultIntervalMinutes ?? 1440;
  const [name, setName] = useState(watch?.name ?? '');
  const [domainsText, setDomainsText] = useState(watch?.domains.join('\n') ?? '');
  // Null until the user picks one: a new watch then takes settings.monitoring.defaultIntervalMinutes.
  const [interval, setIntervalChoice] = useState<number | null>(watch?.intervalMinutes ?? null);
  const [includeRegistry, setIncludeRegistry] = useState(watch?.includeRegistry ?? true);
  const [includeCatalogPrices, setIncludeCatalogPrices] = useState(watch?.includeCatalogPrices ?? false);
  const [providerIds, setProviderIds] = useState<Set<string>>(new Set(watch?.providerIds ?? []));
  const intervalMinutes = interval ?? defaultInterval;

  const parsed = target ? null : parseDomains(domainsText);
  const domainCount = target ? target.count : (parsed?.valid.length ?? 0);
  const eligible = eligibleProviders(providers.data ?? [], watch?.providerIds ?? []);
  const chosen = eligible.filter((p) => providerIds.has(p.id));
  const destinations = [includeRegistry ? 'registry services' : null, ...chosen.map(providerDestination)].filter((d): d is string => Boolean(d));
  const intervalOptions = [...new Set([...INTERVALS, defaultInterval, intervalMinutes])]
    .sort((a, b) => a - b)
    .map((m) => ({ value: String(m), label: formatInterval(m) }));

  const save = useMutation({
    mutationFn: async () => {
      const domains = target ? await target.resolveDomains() : (parsed?.valid ?? []);
      if (domains.length === 0) throw new Error('Add at least one domain.');
      if (domains.length > MAX_WATCH_DOMAINS) throw new Error(`A watch holds at most ${MAX_WATCH_DOMAINS} domains.`);
      const body = {
        name: name.trim() || `Watch of ${plural(domains.length, 'domain')}`,
        domains,
        includeRegistry,
        providerIds: chosen.map((p) => p.id),
        includeCatalogPrices: includeCatalogPrices && chosen.length > 0,
        ...(interval !== null && interval !== watch?.intervalMinutes ? { intervalMinutes: interval } : {}),
      };
      if (watch) return (await api.call('patchWatch', { params: { id: watch.id }, body })).data;
      return (await api.call('createWatch', { body })).data;
    },
    onSuccess: (saved) => {
      client.setQueryData(qk.watch(saved.id), saved);
      void client.invalidateQueries({ queryKey: qk.watches });
      if (watch) toast.success(`Saved ${saved.name}`);
      else {
        toast.success(`Watching ${plural(saved.domains.length, 'domain')}`, {
          action: { label: 'Open', onClick: () => router.push(`/watching/${saved.id}`) },
        });
      }
      onOpenChange(false);
    },
  });

  // Provider choices are known only once providers load; saving earlier would drop a watch's providers.
  const providersReady = providers.isSuccess;
  // The backend needs registry checks or at least one provider; catalog tracking covers the chosen providers.
  const nothingToCheck = !includeRegistry && chosen.length === 0;
  const invalid = parsed?.invalid ?? [];
  const tooMany = domainCount > MAX_WATCH_DOMAINS;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (providersReady && !nothingToCheck && domainCount > 0 && !tooMany) save.mutate();
      }}
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" htmlFor="watch-name">
          <Input id="watch-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </Field>
        {target ? null : (
          <Field
            label="Domains"
            htmlFor="watch-domains"
            hint={
              invalid.length ? (
                <span className="text-negative">Not a domain: {invalid.slice(0, 5).join(', ')}{invalid.length > 5 ? ` and ${invalid.length - 5} more` : ''}</span>
              ) : tooMany ? (
                <span className="text-negative">At most {MAX_WATCH_DOMAINS} domains.</span>
              ) : (
                plural(domainCount, 'domain')
              )
            }
          >
            <Textarea
              id="watch-domains"
              value={domainsText}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-invalid={invalid.length > 0 || tooMany || undefined}
              onChange={(e) => setDomainsText(e.target.value)}
              className="min-h-28 font-mono text-[13px]"
            />
          </Field>
        )}
        <Field label="Interval" htmlFor="watch-interval">
          <Select id="watch-interval" value={String(intervalMinutes)} onValueChange={(v) => setIntervalChoice(Number(v))} options={intervalOptions} />
        </Field>
        <SwitchField id="watch-registry" label="Registry evidence" checked={includeRegistry} onCheckedChange={setIncludeRegistry} />
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Provider checks and quotes</p>
          {providers.isPending ? (
            <SkeletonRows rows={3} />
          ) : providers.isError ? (
            <ErrorState error={providers.error} onRetry={() => providers.refetch()} />
          ) : eligible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No provider can check exact names now.</p>
          ) : (
            <ul className="flex flex-col gap-0.5" aria-label="Providers">
              {eligible.map((provider) => (
                <li key={provider.id}>
                  <label htmlFor={`watch-p-${provider.id}`} className="flex min-h-9 items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-hover">
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
                    <span className="min-w-0 flex-1">
                      <span className="block">{provider.name}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {provider.apiHosts.length ? provider.apiHosts.join(', ') : 'No API host listed'}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <SwitchField
          id="watch-catalog"
          label="Published prices of these providers, no names sent"
          checked={includeCatalogPrices && chosen.length > 0}
          disabled={chosen.length === 0}
          onCheckedChange={setIncludeCatalogPrices}
        />
      </div>
      {destinations.length > 0 ? (
        <Disclosure>
          Each run sends {plural(domainCount, 'domain name')} to {joinNames(destinations)}. Runs happen only while the local backend is running.
        </Disclosure>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!providersReady || nothingToCheck || domainCount === 0 || tooMany || save.isPending}>
          {watch ? 'Save watch' : 'Create watch'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Create or edit a watch. The disclosure names every host that receives names before saving. */
export function WatchFormDialog({ open, onOpenChange, watch, target }: WatchFormProps) {
  const title = watch ? `Edit ${watch.name}` : target ? `Watch ${plural(target.count, 'domain')}` : 'New watch';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title}>{open ? <WatchFormBody onOpenChange={onOpenChange} watch={watch} target={target} /> : null}</DialogContent>
    </Dialog>
  );
}
