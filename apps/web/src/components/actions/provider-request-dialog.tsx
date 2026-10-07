'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import type { CapabilityName, Provider } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { CAPABILITY_LEVEL, READINESS } from '@/lib/labels';
import { plural } from '@/lib/format';
import { useProviders } from '@/lib/queries';
import { useIdempotency } from '@/lib/use-idempotency';
import { ErrorState } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogFooter } from '../ui/dialog';
import { Segmented } from '../ui/segmented';
import { SkeletonRows } from '../ui/skeleton';
import { Disclosure, joinNames } from './disclosure';
import type { DomainTarget } from './types';
import { useJobStarted } from './use-job-started';

export type ProviderOperation = 'quote' | 'provider_check' | 'transfer';

const OPERATIONS: { value: ProviderOperation; label: string; capability: CapabilityName; started: string }[] = [
  { value: 'quote', label: 'Quotes', capability: 'quote', started: 'Quotes requested' },
  { value: 'provider_check', label: 'Provider checks', capability: 'exactCheck', started: 'Provider checks started' },
  { value: 'transfer', label: 'Transfer prices', capability: 'transfer', started: 'Transfer price lookups started' },
];

/** Usable for this capability now: enabled, supported, and with credentials when they are required. */
function blockedReason(provider: Provider, capability: CapabilityName): string | null {
  const cap = provider.capabilities[capability];
  if (cap.requiresCredentials && !provider.credentials.configured) return 'Needs credentials';
  if (provider.readiness === 'credentials_invalid' && cap.requiresCredentials) return 'Invalid credentials';
  return null;
}

/**
 * Exact-name quotes, provider availability checks or transfer prices for selected domains and
 * providers. Names go only to the chosen providers, which the disclosure line names before submit.
 */
export function ProviderRequestDialog({
  open,
  onOpenChange,
  target,
  defaultOperation = 'quote',
  defaultSelected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: DomainTarget;
  defaultOperation?: ProviderOperation;
  /** Providers checked initially, e.g. from restored criteria. */
  defaultSelected?: string[];
}) {
  const providers = useProviders();
  const [operation, setOperation] = useState<ProviderOperation>(defaultOperation);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(defaultSelected));
  const idempotency = useIdempotency();
  const started = useJobStarted();
  const op = OPERATIONS.find((o) => o.value === operation)!;

  const eligible = (providers.data ?? []).filter((p) => p.enabled && p.capabilities[op.capability].level !== 'unsupported');
  const chosen = eligible.filter((p) => selected.has(p.id) && !blockedReason(p, op.capability));

  const mutation = useMutation({
    mutationFn: async () => {
      const domains = await target.resolveDomains();
      if (domains.length === 0) throw new Error('Nothing selected.');
      const body = { domains, providerIds: chosen.map((p) => p.id) };
      const idempotencyKey = idempotency.keyFor({ operation, body });
      const call =
        operation === 'quote'
          ? api.call('createQuotes', { body, idempotencyKey })
          : operation === 'provider_check'
            ? api.call('createProviderChecks', { body, idempotencyKey })
            : api.call('createTransfers', { body, idempotencyKey });
      return (await call).data;
    },
    onSuccess: (job) => {
      idempotency.reset();
      started(job, op.started);
      onOpenChange(false);
    },
  });

  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Provider requests for ${plural(target.count, 'domain')}`}>
        <Segmented aria-label="Request" value={operation} onValueChange={setOperation} options={OPERATIONS} className="mb-4" />
        {providers.isPending ? (
          <SkeletonRows rows={4} />
        ) : providers.isError ? (
          <ErrorState error={providers.error} onRetry={() => providers.refetch()} />
        ) : eligible.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">No enabled provider supports this.</p>
        ) : (
          <ul className="flex flex-col gap-0.5" aria-label="Providers">
            {eligible.map((provider) => {
              const blocked = blockedReason(provider, op.capability);
              const id = `provider-${provider.id}`;
              return (
                <li key={provider.id}>
                  <label
                    htmlFor={id}
                    className="flex min-h-10 items-center gap-3 rounded-md px-3 text-sm transition-colors hover:bg-hover has-[button:disabled]:hover:bg-transparent"
                  >
                    <Checkbox
                      id={id}
                      checked={selected.has(provider.id) && !blocked}
                      disabled={Boolean(blocked)}
                      onCheckedChange={(value) => toggle(provider.id, value === true)}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">{provider.name}</span>
                    <span className="text-xs text-muted-foreground">{CAPABILITY_LEVEL[provider.capabilities[op.capability].level]}</span>
                    {blocked ? (
                      <Link href={`/settings/providers?p=${provider.id}`} className="text-xs underline underline-offset-4">
                        {blocked}
                      </Link>
                    ) : (
                      <StatusLabel status={READINESS[provider.readiness]} className="text-xs" />
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {chosen.length > 0 ? (
          <Disclosure>
            Sends {plural(target.count, 'domain name')} to {joinNames(chosen.map((p) => p.name))}.
          </Disclosure>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={chosen.length === 0 || mutation.isPending} onClick={() => mutation.mutate()}>
            Send requests
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
