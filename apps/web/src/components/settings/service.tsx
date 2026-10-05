'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Power } from 'lucide-react';
import { CONTRACT_VERSION } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { READINESS, humanize, jobTypeLabel } from '@/lib/labels';
import { formatCount, formatDateTime } from '@/lib/format';
import { qk } from '@/lib/queries';
import { RelativeTime } from '../domain/time';
import { ErrorState, Facts, SectionTitle } from '../states';
import { StatusLabel, ToneText } from '../status';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';

const SERVICE_NAME: Record<string, string> = {
  github: 'GitHub',
  npm: 'npm',
  pypi: 'PyPI',
  crates: 'crates.io',
  x: 'X',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  reddit: 'Reddit',
};
const CHECK_NAME: Record<string, string> = { dns: 'DNS', nameservers: 'Nameservers', dnssec: 'DNSSEC', tls: 'TLS', http: 'HTTP' };

export function ServiceSettings() {
  const [confirming, setConfirming] = useState(false);
  const health = useQuery({
    queryKey: qk.health,
    queryFn: ({ signal }) => api.call('getHealth', { signal }).then((r) => r.data),
  });
  const capabilities = useQuery({
    queryKey: qk.capabilities,
    queryFn: ({ signal }) => api.call('getCapabilities', { signal }).then((r) => r.data),
  });
  const stop = useMutation({
    mutationFn: async () => (await api.call('stopService')).data,
    onSuccess: () => setConfirming(false),
  });

  const caps = capabilities.data;
  return (
    <section aria-label="Service" className="grid max-w-5xl gap-x-10 gap-y-8 xl:grid-cols-2">
      <div className="min-w-0">
        <SectionTitle>Backend</SectionTitle>
        {health.isPending ? (
          <Skeleton className="h-40" />
        ) : health.isError ? (
          <ErrorState error={health.error} onRetry={() => health.refetch()} />
        ) : (
          <Facts
            items={[
              ['Version', <span key="v" className="font-mono">{health.data.version}</span>],
              [
                'Contract',
                <span key="c" className="font-mono">
                  {health.data.contractVersion}
                  {health.data.contractVersion !== CONTRACT_VERSION ? (
                    <ToneText tone="caution" className="ml-2 font-sans">
                      Interface expects {CONTRACT_VERSION}
                    </ToneText>
                  ) : null}
                </span>,
              ],
              ['Protocol', <span key="p" className="font-mono">{health.data.protocolVersion}</span>],
              ['Started', <span key="s" title={formatDateTime(health.data.startedAt)}><RelativeTime iso={health.data.startedAt} /></span>],
              ['Process', <span key="pid" className="font-mono">{health.data.pid}</span>],
              ['Instance', <span key="i" className="break-all font-mono text-[13px]">{health.data.instanceId}</span>],
              ['Data', <span key="d" className="break-all font-mono text-[13px]">{health.data.dataDir}</span>],
            ]}
          />
        )}
      </div>

      <div className="min-w-0 xl:row-span-2">
        <SectionTitle>Capabilities</SectionTitle>
        {capabilities.isPending ? (
          <Skeleton className="h-40" />
        ) : capabilities.isError ? (
          <ErrorState error={capabilities.error} onRetry={() => capabilities.refetch()} />
        ) : caps ? (
          <Facts
            items={[
              [
                'Registry',
                <span key="r">
                  <span className="font-mono tabular">{formatCount(caps.registry.tested)}</span> tested, <span className="font-mono tabular">{formatCount(caps.registry.discovered)}</span> discovered,{' '}
                  <span className="font-mono tabular">{formatCount(caps.registry.unsupported)}</span> unsupported
                  <span className="block text-muted-foreground">{caps.registry.protocols.map((p) => p.toUpperCase()).join(', ')}</span>
                </span>,
              ],
              [
                'Providers',
                <ul key="p" className="flex flex-col gap-1">
                  {caps.providers.map((p) => (
                    <li key={p.id} className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-3">
                      <span className="truncate">{p.name}</span>
                      <StatusLabel status={READINESS[p.readiness]} className="text-muted-foreground" />
                    </li>
                  ))}
                </ul>,
              ],
              ['Jobs', caps.jobTypes.map(jobTypeLabel).join(', ')],
              ['Name checks', caps.nameCheckServices.length ? caps.nameCheckServices.map((id) => SERVICE_NAME[id] ?? humanize(id)).join(', ') : 'None'],
              ['Diagnostics', caps.diagnostics.length ? caps.diagnostics.map((d) => CHECK_NAME[d] ?? humanize(d)).join(', ') : 'None'],
              ['Exports', caps.exportFormats.map((f) => f.toUpperCase()).join(', ')],
              ['MCP adapter', caps.mcp ? 'Available' : 'Not installed'],
            ]}
          />
        ) : null}
      </div>

      <div className="min-w-0">
        <SectionTitle>Stop</SectionTitle>
        {stop.isSuccess ? (
          <p className="text-sm" role="status">
            Stopping. Unfinished work becomes interrupted and can be resumed after the next start.
          </p>
        ) : (
          <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
            <Power />
            Stop backend
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Stop the local backend?"
        description="Running checks stop and become interrupted. Watches do not run until the backend starts again, and this interface stops working."
        confirmLabel="Stop backend"
        pending={stop.isPending}
        onConfirm={() => stop.mutate()}
      />
    </section>
  );
}
