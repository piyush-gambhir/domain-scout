'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { Provider } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { CAPABILITY_LEVEL, CAPABILITY_NAME, CAPABILITY_ORDER, READINESS, humanize } from '@/lib/labels';
import { formatDate, formatCount, hostOf } from '@/lib/format';
import { qk, useProviders } from '@/lib/queries';
import { useIdempotency } from '@/lib/use-idempotency';
import { cn } from '@/lib/utils';
import { useJobStarted } from '../actions/use-job-started';
import { FreshnessText, RelativeTime } from '../domain/time';
import { EmptyState, ErrorState, Facts, PageHeader, SectionTitle } from '../states';
import { StatusLabel, ToneText } from '../status';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Segmented } from '../ui/segmented';
import { Skeleton, SkeletonRows } from '../ui/skeleton';
import { Switch } from '../ui/switch';

function usePatchProvider(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { enabled?: boolean; preferred?: boolean }) => (await api.call('patchProvider', { params: { id }, body: patch })).data,
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: qk.providers });
      const previous = client.getQueryData<Provider[]>(qk.providers);
      client.setQueryData<Provider[]>(qk.providers, (list) => list?.map((p) => (p.id === id ? { ...p, ...patch } : p)));
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) client.setQueryData(qk.providers, context.previous);
    },
    onSuccess: (provider) => client.setQueryData<Provider[]>(qk.providers, (list) => list?.map((p) => (p.id === provider.id ? provider : p))),
    onSettled: () => void client.invalidateQueries({ queryKey: ['evidence'] }),
  });
}

function replaceProvider(client: ReturnType<typeof useQueryClient>, provider: Provider) {
  client.setQueryData<Provider[]>(qk.providers, (list) => list?.map((p) => (p.id === provider.id ? provider : p)));
}

const STORAGE_LABEL = { env: 'environment variables', session: 'this session only', file: 'local credential file' } as const;

function Credentials({ provider }: { provider: Provider }) {
  const client = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [storage, setStorage] = useState<'session' | 'file'>(provider.credentials.storage === 'file' ? 'file' : 'session');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const fieldsSet = new Map(provider.credentials.fields.map((f) => [f.key, f.set]));

  const entered = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
  const missingRequired = provider.credentialFields.some((f) => f.required && !entered[f.key] && !fieldsSet.get(f.key));
  const canSave = Object.keys(entered).length > 0 && !missingRequired;

  const save = useMutation({
    mutationFn: async () => (await api.call('putProviderCredentials', { params: { id: provider.id }, body: { values: entered, storage } })).data,
    onSuccess: (updated) => {
      // Secrets leave the form as soon as they are saved; the API never returns them.
      setValues({});
      replaceProvider(client, updated);
      toast.success(`Saved ${provider.name} credentials`);
    },
  });
  const test = useMutation({
    mutationFn: async () => (await api.call('testProviderCredentials', { params: { id: provider.id } })).data,
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: qk.providers });
      if (result.result === 'ok') toast.success(result.message);
      else if (result.result === 'failed') toast.error(result.message);
      else toast(result.message);
    },
  });
  const disconnect = useMutation({
    mutationFn: async () => (await api.call('deleteProviderCredentials', { params: { id: provider.id } })).data,
    onSuccess: (updated) => {
      setConfirmDisconnect(false);
      replaceProvider(client, updated);
      toast.success(`Disconnected ${provider.name}`);
    },
  });

  const creds = provider.credentials;
  return (
    <section className="mt-10" aria-label="Credentials">
      <SectionTitle>Credentials</SectionTitle>
      <p className="mb-4 text-sm">
        {creds.configured ? (
          <>
            Configured
            {creds.storage ? <span className="text-muted-foreground"> · {STORAGE_LABEL[creds.storage]}</span> : null}
          </>
        ) : (
          <span className="text-muted-foreground">Not configured</span>
        )}
      </p>
      {creds.storage === 'file' && creds.storageLocation ? (
        <p className="-mt-2 mb-4 break-all font-mono text-xs text-muted-foreground">{creds.storageLocation}</p>
      ) : null}
      <form
        autoComplete="off"
        className="flex max-w-lg flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        {provider.credentialFields.map((field) => {
          const id = `cred-${provider.id}-${field.key}`;
          const isSet = fieldsSet.get(field.key);
          return (
            <div key={field.key} className="flex flex-col gap-1.5">
              <Label htmlFor={id} className="text-xs text-muted-foreground">
                {field.label}
                {field.required ? '' : ' (optional)'}
              </Label>
              <Input
                id={id}
                name={`${provider.id}-${field.key}`}
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                placeholder={isSet ? 'Saved' : ''}
                value={values[field.key] ?? ''}
                onChange={(e) => setValues((current) => ({ ...current, [field.key]: e.target.value }))}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                {field.help ? `${field.help} ` : ''}
                <span className="font-mono">{field.envVar}</span>
              </p>
            </div>
          );
        })}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Keep saved credentials in</span>
          <Segmented
            aria-label="Credential storage"
            value={storage}
            onValueChange={setStorage}
            options={[
              { value: 'session', label: 'This session' },
              { value: 'file', label: 'Local file' },
            ]}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={!canSave || save.isPending}>
            Save
          </Button>
          <Button variant="secondary" disabled={!creds.configured || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? 'Testing' : 'Test'}
          </Button>
          <Button variant="ghost" disabled={!creds.configured || creds.storage === 'env' || disconnect.isPending} onClick={() => setConfirmDisconnect(true)}>
            Disconnect
          </Button>
        </div>
      </form>
      {creds.lastTestedAt ? (
        <p className="mt-4 text-sm">
          <span className="text-muted-foreground">Last test </span>
          <RelativeTime iso={creds.lastTestedAt} />
          {': '}
          <ToneText tone={creds.lastTestResult === 'ok' ? 'positive' : creds.lastTestResult === 'failed' ? 'negative' : 'muted'}>
            {creds.lastTestResult === 'ok' ? 'Passed' : creds.lastTestResult === 'failed' ? 'Failed' : 'Not testable'}
          </ToneText>
          {creds.lastTestMessage ? <span className="text-muted-foreground"> · {creds.lastTestMessage}</span> : null}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={`Disconnect ${provider.name}?`}
        description="Saved credentials are removed. Keyless capabilities keep working."
        confirmLabel="Disconnect"
        pending={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </section>
  );
}

function Catalog({ provider }: { provider: Provider }) {
  const started = useJobStarted();
  const idempotency = useIdempotency();
  const refresh = useMutation({
    mutationFn: async () =>
      (await api.call('refreshProviderCatalog', { params: { id: provider.id }, idempotencyKey: idempotency.keyFor({ catalog: provider.id }) })).data,
    onSuccess: (job) => {
      idempotency.reset();
      started(job, `Refreshing ${provider.name} catalog`);
    },
  });
  const catalog = provider.catalog;
  return (
    <section className="mt-10" aria-label="Catalog">
      <div className="mb-3 flex items-center justify-between gap-4">
        <SectionTitle className="mb-0">Catalog</SectionTitle>
        <Button size="sm" variant="secondary" disabled={refresh.isPending || !provider.enabled} onClick={() => refresh.mutate()}>
          <RefreshCw className={cn(refresh.isPending && 'motion-safe:animate-spin')} />
          Refresh
        </Button>
      </div>
      {catalog ? (
        <Facts
          items={[
            ['Extensions', <span key="n" className="font-mono">{formatCount(catalog.suffixCount)}</span>],
            [
              'Fetched',
              <span key="f">
                <RelativeTime iso={catalog.fetchedAt} /> <FreshnessText freshness={catalog.freshness} staleAt={catalog.staleAt} hideFresh />
              </span>,
            ],
            ['Source', catalog.source ? <span key="s" className="break-all font-mono text-[13px]">{hostOf(catalog.source)}</span> : 'Unknown'],
            ...(catalog.lastError ? [['Last error', <ToneText key="e" tone="negative">{catalog.lastError.message}</ToneText>] as [string, React.ReactNode]] : []),
          ]}
        />
      ) : (
        <p className="text-sm text-muted-foreground">No catalog fetched.</p>
      )}
    </section>
  );
}

function ProviderDetail({ provider }: { provider: Provider }) {
  const patch = usePatchProvider(provider.id);
  return (
    <article aria-label={provider.name}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{provider.name}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span>{provider.kind === 'directory' ? 'Registry directory' : 'Registrar'}</span>
            <a href={provider.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline">
              {hostOf(provider.website)}
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
            {provider.setupUrl ? (
              <a href={provider.setupUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline">
                Account setup
                <ExternalLink aria-hidden className="size-3.5" />
              </a>
            ) : null}
          </p>
        </div>
        <StatusLabel status={READINESS[provider.readiness]} className="text-sm font-medium" />
      </header>

      <div className="mt-6 flex flex-wrap gap-x-10 gap-y-3">
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={provider.enabled} onCheckedChange={(enabled) => patch.mutate({ enabled })} aria-label="Enabled" />
          Enabled
        </label>
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={provider.preferred} disabled={!provider.enabled} onCheckedChange={(preferred) => patch.mutate({ preferred })} aria-label="Preferred" />
          Preferred
        </label>
      </div>

      <section className="mt-10" aria-label="Capabilities">
        <SectionTitle>Capabilities</SectionTitle>
        <ul className="flex flex-col gap-2 text-sm">
          {CAPABILITY_ORDER.map((name) => {
            const capability = provider.capabilities[name];
            const unsupported = capability.level === 'unsupported';
            return (
              <li key={name} className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 sm:grid-cols-[9rem_9rem_minmax(0,1fr)]">
                <span className="text-muted-foreground">{CAPABILITY_NAME[name]}</span>
                <span className={cn(unsupported ? 'text-muted-foreground' : 'font-medium')}>{CAPABILITY_LEVEL[capability.level]}</span>
                <span className="col-start-2 text-xs text-muted-foreground sm:col-start-auto sm:text-sm">
                  {[
                    capability.requiresCredentials && !unsupported ? 'Needs credentials' : null,
                    capability.verifiedAt ? `verified ${formatDate(capability.verifiedAt)}` : null,
                    capability.notes,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  {capability.source ? (
                    <a href={capability.source} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 underline-offset-4 hover:underline">
                      Source
                      <ExternalLink aria-hidden className="size-3" />
                    </a>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {provider.purchaseLink ? (
        <section className="mt-10" aria-label="Purchase link">
          <SectionTitle>Purchase link</SectionTitle>
          <Facts
            items={[
              [
                'Kind',
                provider.purchaseLink.kind === 'dashboard'
                  ? 'Dashboard (sign-in required)'
                  : provider.purchaseLink.kind === 'website'
                    ? 'Website (name not prefilled)'
                    : 'Search page',
              ],
              ['Template', <span key="t" className="break-all font-mono text-[13px]">{provider.purchaseLink.template}</span>],
              ['Verified', formatDate(provider.purchaseLink.verifiedAt)],
            ]}
          />
        </section>
      ) : null}

      {provider.credentialFields.length > 0 ? <Credentials key={provider.id} provider={provider} /> : null}
      {provider.capabilities.catalog.level !== 'unsupported' || provider.catalog ? <Catalog provider={provider} /> : null}

      {provider.accountRequirements.length > 0 || provider.rateLimits ? (
        <section className="mt-10" aria-label="Account">
          <SectionTitle>Account</SectionTitle>
          {provider.accountRequirements.length > 0 ? (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {provider.accountRequirements.map((req) => (
                <li key={req}>{req}</li>
              ))}
            </ul>
          ) : null}
          {provider.rateLimits ? <p className="mt-3 text-sm text-muted-foreground">Rate limits: {provider.rateLimits}</p> : null}
        </section>
      ) : null}

      {provider.suffixes ? (
        <p className="mt-10 text-sm text-muted-foreground">
          Supports {formatCount(provider.suffixes.length)} known extensions
        </p>
      ) : null}
    </article>
  );
}

export function ProvidersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const providers = useProviders();
  const selectedId = searchParams.get('p');
  const list = providers.data ?? [];
  const selected = list.find((p) => p.id === selectedId) ?? (selectedId ? undefined : list[0]);
  const select = (id: string | null) => router.replace(id ? `/providers?p=${id}` : '/providers', { scroll: false });

  const groups: [string, Provider[]][] = [
    ['Registrars', list.filter((p) => p.kind === 'registrar')],
    ['Registry directories', list.filter((p) => p.kind === 'directory')],
  ];

  return (
    <>
      <PageHeader title="Providers" />
      {providers.isPending ? (
        <div className="grid gap-10 md:grid-cols-[15rem_minmax(0,1fr)]">
          <SkeletonRows rows={9} />
          <Skeleton className="h-96" />
        </div>
      ) : providers.isError ? (
        <ErrorState error={providers.error} onRetry={() => providers.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState>No providers.</EmptyState>
      ) : (
        <div className="grid gap-10 md:grid-cols-[15rem_minmax(0,1fr)]">
          <nav aria-label="Providers" className={cn('flex flex-col gap-6', selectedId && 'max-md:hidden')}>
            {groups
              .filter(([, items]) => items.length > 0)
              .map(([label, items]) => (
                <div key={label}>
                  <p className="mb-1 px-3 text-xs font-medium text-muted-foreground">{label}</p>
                  <ul className="flex flex-col gap-0.5">
                    {items.map((provider) => (
                      <li key={provider.id}>
                        <button
                          type="button"
                          aria-current={selected?.id === provider.id ? 'true' : undefined}
                          onClick={() => select(provider.id)}
                          className={cn(
                            'flex h-10 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-sm transition-colors hover:bg-hover aria-[current=true]:bg-selected aria-[current=true]:font-medium',
                            !provider.enabled && 'text-muted-foreground',
                          )}
                        >
                          <span className="truncate">{provider.name}</span>
                          <StatusLabel status={READINESS[provider.readiness]} className="shrink-0 text-xs font-normal text-muted-foreground" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </nav>
          <div className={cn('min-w-0', !selectedId && 'max-md:hidden')}>
            {selectedId ? (
              <Button size="sm" variant="quiet" className="-ml-3 mb-3 md:hidden" onClick={() => select(null)}>
                <ArrowLeft />
                Providers
              </Button>
            ) : null}
            {selected ? <ProviderDetail key={selected.id} provider={selected} /> : <EmptyState>{humanize(selectedId ?? 'provider')} not found.</EmptyState>}
          </div>
        </div>
      )}
    </>
  );
}
