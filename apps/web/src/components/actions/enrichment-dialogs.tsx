'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { DiagnosticCheck, NameCheckServiceId, Resolver } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { plural } from '@/lib/format';
import { useNameCheckServices, useSettings } from '@/lib/queries';
import { useIdempotency } from '@/lib/use-idempotency';
import { uniq } from '@/lib/utils';
import { ErrorState } from '../states';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogFooter } from '../ui/dialog';
import { Segmented } from '../ui/segmented';
import { SkeletonRows } from '../ui/skeleton';
import { Disclosure, joinNames } from './disclosure';
import type { DomainTarget } from './types';
import { useJobStarted } from './use-job-started';

const rowClass = 'flex min-h-10 items-center gap-3 rounded-md px-3 text-sm transition-colors hover:bg-hover';

/** Registrable labels (the part before the suffix) of the selected domains; punycode labels are skipped. */
export function labelsOf(domains: string[]): string[] {
  return uniq(domains.map((d) => d.split('.')[0] ?? '').filter((label) => label && !label.startsWith('xn--')));
}

export function NameCheckDialog({ open, onOpenChange, target }: { open: boolean; onOpenChange: (open: boolean) => void; target: DomainTarget }) {
  const services = useNameCheckServices();
  const [selected, setSelected] = useState<Set<NameCheckServiceId>>(new Set());
  const idempotency = useIdempotency();
  const started = useJobStarted();
  const supported = (services.data ?? []).filter((s) => s.supported);
  const unsupported = (services.data ?? []).filter((s) => !s.supported);
  const chosen = supported.filter((s) => selected.has(s.id));

  const mutation = useMutation({
    mutationFn: async () => {
      const names = labelsOf(await target.resolveDomains());
      if (names.length === 0) throw new Error('No checkable names in the selection.');
      const body = { names, services: chosen.map((s) => s.id) };
      return (await api.call('createNameChecks', { body, idempotencyKey: idempotency.keyFor(body) })).data;
    },
    onSuccess: (job) => {
      idempotency.reset();
      started(job, 'Name checks started');
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Name checks">
        <p className="mb-4 text-sm text-muted-foreground">Names from {plural(target.count, 'selected domain')}</p>
        {services.isPending ? (
          <SkeletonRows rows={4} />
        ) : services.isError ? (
          <ErrorState error={services.error} onRetry={() => services.refetch()} />
        ) : (
          <ul className="flex flex-col gap-0.5" aria-label="Services">
            {supported.map((service) => (
              <li key={service.id}>
                <label htmlFor={`svc-${service.id}`} className={rowClass}>
                  <Checkbox
                    id={`svc-${service.id}`}
                    checked={selected.has(service.id)}
                    onCheckedChange={(value) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (value === true) next.add(service.id);
                        else next.delete(service.id);
                        return next;
                      })
                    }
                  />
                  <span className="flex-1 font-medium">{service.name}</span>
                  <span className="text-xs text-muted-foreground">{service.namespace}</span>
                </label>
              </li>
            ))}
            {unsupported.map((service) => (
              <li key={service.id} className={`${rowClass} text-muted-foreground hover:bg-transparent`}>
                <Checkbox disabled aria-label={`${service.name} unsupported`} />
                <span className="flex-1">{service.name}</span>
                <span className="truncate text-xs">{service.reason ?? 'Unsupported'}</span>
              </li>
            ))}
          </ul>
        )}
        {chosen.length > 0 ? (
          <Disclosure>Sends names to {joinNames(chosen.map((s) => s.destination ?? s.name))}.</Disclosure>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={chosen.length === 0 || mutation.isPending} onClick={() => mutation.mutate()}>
            Run checks
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CHECKS: { value: DiagnosticCheck; label: string }[] = [
  { value: 'dns', label: 'DNS records' },
  { value: 'nameservers', label: 'Nameservers' },
  { value: 'dnssec', label: 'DNSSEC' },
  { value: 'tls', label: 'TLS certificate' },
  { value: 'http', label: 'Website (HTTP)' },
];

const RESOLVERS: { value: Resolver; label: string; destination: string }[] = [
  { value: 'system', label: 'System', destination: 'your system resolver' },
  { value: 'cloudflare', label: 'Cloudflare', destination: 'cloudflare-dns.com' },
  { value: 'google', label: 'Google', destination: 'dns.google' },
];

export function DiagnosticsDialog({ open, onOpenChange, target }: { open: boolean; onOpenChange: (open: boolean) => void; target: DomainTarget }) {
  const [checks, setChecks] = useState<Set<DiagnosticCheck>>(new Set(['dns', 'nameservers']));
  const settings = useSettings();
  // Null until changed here: the request then omits it and settings.diagnostics.resolver applies.
  const [chosenResolver, setResolver] = useState<Resolver | null>(null);
  const resolver: Resolver = chosenResolver ?? settings.data?.diagnostics.resolver ?? 'system';
  const idempotency = useIdempotency();
  const started = useJobStarted();
  const chosen = CHECKS.filter((c) => checks.has(c.value));
  const dnsChecks = chosen.some((c) => c.value === 'dns' || c.value === 'nameservers' || c.value === 'dnssec');
  const hostChecks = chosen.some((c) => c.value === 'tls' || c.value === 'http');
  const destinations = [
    dnsChecks ? RESOLVERS.find((r) => r.value === resolver)!.destination : null,
    hostChecks ? "each domain's own web server" : null,
  ].filter((d): d is string => Boolean(d));

  const mutation = useMutation({
    mutationFn: async () => {
      const domains = await target.resolveDomains();
      if (domains.length === 0) throw new Error('Nothing selected.');
      const body = { domains, checks: chosen.map((c) => c.value), ...(chosenResolver ? { resolver: chosenResolver } : {}) };
      return (await api.call('createDiagnostics', { body, idempotencyKey: idempotency.keyFor(body) })).data;
    },
    onSuccess: (job) => {
      idempotency.reset();
      started(job, 'Diagnostics started');
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Diagnostics for ${plural(target.count, 'domain')}`}>
        <ul className="flex flex-col gap-0.5" aria-label="Checks">
          {CHECKS.map((check) => (
            <li key={check.value}>
              <label htmlFor={`chk-${check.value}`} className={rowClass}>
                <Checkbox
                  id={`chk-${check.value}`}
                  checked={checks.has(check.value)}
                  onCheckedChange={(value) =>
                    setChecks((current) => {
                      const next = new Set(current);
                      if (value === true) next.add(check.value);
                      else next.delete(check.value);
                      return next;
                    })
                  }
                />
                {check.label}
              </label>
            </li>
          ))}
        </ul>
        {dnsChecks ? (
          <div className="mt-4 flex items-center justify-between gap-4">
            <span className="text-sm">Resolver</span>
            <Segmented aria-label="Resolver" size="sm" value={resolver} onValueChange={setResolver} options={RESOLVERS} />
          </div>
        ) : null}
        {destinations.length > 0 ? (
          <Disclosure>
            Contacts {joinNames(destinations)} for {plural(target.count, 'domain')}.
          </Disclosure>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={chosen.length === 0 || mutation.isPending} onClick={() => mutation.mutate()}>
            Run diagnostics
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
