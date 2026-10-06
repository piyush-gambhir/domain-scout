'use client';

import { useId, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, ExternalLink, RefreshCw, Search } from 'lucide-react';
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
import { EmptyState, ErrorState, Facts, Page, PageHeader, SectionTitle } from '../states';
import { StatusLabel, ToneText } from '../status';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Segmented } from '../ui/segmented';
import { SkeletonRows } from '../ui/skeleton';
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
    <section aria-label="Credentials" className="min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <SectionTitle className="mb-0">Credentials</SectionTitle>
        <span className="text-sm">
          {creds.configured ? (
            <>
              Configured
              {creds.storage ? <span className="text-muted-foreground"> · {STORAGE_LABEL[creds.storage]}</span> : null}
            </>
          ) : (
            <span className="text-muted-foreground">Not configured</span>
          )}
        </span>
      </div>
      {creds.storage === 'file' && creds.storageLocation ? <p className="mb-2 break-all font-mono text-xs text-muted-foreground">{creds.storageLocation}</p> : null}
      <form
        autoComplete="off"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        {provider.credentialFields.map((field) => {
          const id = `cred-${provider.id}-${field.key}`;
          const isSet = fieldsSet.get(field.key);
          return (
            <div key={field.key} className="flex flex-col gap-1">
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
                <span className="break-all font-mono">{field.envVar}</span>
              </p>
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span aria-hidden className="text-xs text-muted-foreground">
            Keep credentials in
          </span>
          <Segmented
            aria-label="Keep credentials in"
            value={storage}
            onValueChange={setStorage}
            options={[
              { value: 'session', label: 'This session' },
              { value: 'file', label: 'Local file' },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="submit" size="sm" variant="primary" disabled={!canSave || save.isPending}>
            Save
          </Button>
          <Button size="sm" variant="secondary" disabled={!creds.configured || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? 'Testing' : 'Test'}
          </Button>
          <Button size="sm" variant="ghost" disabled={!creds.configured || creds.storage === 'env' || disconnect.isPending} onClick={() => setConfirmDisconnect(true)}>
            Disconnect
          </Button>
        </div>
      </form>
      {creds.lastTestedAt ? (
        <p className="mt-2 text-xs">
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
    <section aria-label="Catalog" className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-4">
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

const LONG_NOTE = 90;

function CapabilityRow({ name, provider }: { name: (typeof CAPABILITY_ORDER)[number]; provider: Provider }) {
  const [expanded, setExpanded] = useState(false);
  const capability = provider.capabilities[name];
  const unsupported = capability.level === 'unsupported';
  const note = [capability.requiresCredentials && !unsupported ? 'Needs credentials' : null, capability.verifiedAt ? `verified ${formatDate(capability.verifiedAt)}` : null, capability.notes]
    .filter(Boolean)
    .join(' · ');
  const long = note.length > LONG_NOTE;
  return (
    <tr className="align-top">
      <th scope="row" className="py-1 pr-3 text-left font-normal text-muted-foreground">
        {CAPABILITY_NAME[name]}
      </th>
      <td className={cn('py-1 pr-3', unsupported ? 'text-muted-foreground' : 'font-medium')}>{CAPABILITY_LEVEL[capability.level]}</td>
      <td className="py-1 text-muted-foreground">
        <div className="flex min-w-0 items-start gap-2">
          <span className={cn('min-w-0 flex-1', long && !expanded && 'truncate')}>{note}</span>
          {long ? (
            <button type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className="shrink-0 rounded-sm text-foreground underline-offset-4 hover:underline">
              {expanded ? 'Less' : 'More'}
              <span className="sr-only"> about {CAPABILITY_NAME[name]}</span>
            </button>
          ) : null}
          {capability.source ? (
            <a href={capability.source} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 rounded-sm text-foreground underline-offset-4 hover:underline">
              Source
              <ExternalLink aria-hidden className="size-3" />
              <span className="sr-only"> for {CAPABILITY_NAME[name]} (opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function ProviderDetail({ provider }: { provider: Provider }) {
  const patch = usePatchProvider(provider.id);
  const purchase = provider.purchaseLink;
  const hasAccount = provider.accountRequirements.length > 0 || provider.rateLimits;
  return (
    <article aria-label={provider.name} className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">{provider.name}</h2>
          <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
            <span>{provider.kind === 'directory' ? 'Registry directory' : 'Registrar'}</span>
            <a href={provider.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-sm underline-offset-4 hover:text-foreground hover:underline">
              {hostOf(provider.website)}
              <ExternalLink aria-hidden className="size-3" />
            </a>
            {provider.setupUrl ? (
              <a href={provider.setupUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-sm underline-offset-4 hover:text-foreground hover:underline">
                Account setup
                <ExternalLink aria-hidden className="size-3" />
              </a>
            ) : null}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={provider.enabled} onCheckedChange={(enabled) => patch.mutate({ enabled })} aria-label="Enabled" />
            Enabled
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={provider.preferred} disabled={!provider.enabled} onCheckedChange={(preferred) => patch.mutate({ preferred })} aria-label="Preferred" />
            Preferred
          </label>
          <StatusLabel status={READINESS[provider.readiness]} className="font-medium" />
        </div>
      </header>

      <section aria-label="Capabilities" className="min-w-0">
        <SectionTitle>Capabilities</SectionTitle>
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-28" />
            <col className="w-28" />
            <col />
          </colgroup>
          <tbody>
            {CAPABILITY_ORDER.map((name) => (
              <CapabilityRow key={name} name={name} provider={provider} />
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        {provider.credentialFields.length > 0 ? <Credentials key={provider.id} provider={provider} /> : null}
        <div className="flex min-w-0 flex-col gap-5">
          {purchase ? (
            <section aria-label="Purchase link" className="min-w-0">
              <SectionTitle>Purchase link</SectionTitle>
              <Facts
                items={[
                  ['Kind', purchase.kind === 'dashboard' ? 'Dashboard (sign-in required)' : purchase.kind === 'website' ? 'Website (name not prefilled)' : 'Search page'],
                  ['Template', <span key="t" className="break-all font-mono text-xs">{purchase.template}</span>],
                  ['Verified', formatDate(purchase.verifiedAt)],
                ]}
              />
            </section>
          ) : null}
          {provider.capabilities.catalog.level !== 'unsupported' || provider.catalog ? <Catalog provider={provider} /> : null}
          {hasAccount || provider.suffixes ? (
            <section aria-label="Account" className="min-w-0">
              <SectionTitle>Account</SectionTitle>
              {provider.accountRequirements.length > 0 ? (
                <ul className="flex list-disc flex-col gap-1 pl-4 text-sm">
                  {provider.accountRequirements.map((req) => (
                    <li key={req}>{req}</li>
                  ))}
                </ul>
              ) : null}
              {provider.rateLimits ? <p className="mt-2 text-xs text-muted-foreground">Rate limits: {provider.rateLimits}</p> : null}
              {provider.suffixes ? <p className="mt-2 text-xs text-muted-foreground">Supports {formatCount(provider.suffixes.length)} known extensions</p> : null}
            </section>
          ) : null}
        </div>
      </div>
    </article>
  );
}

const itemClass =
  'focus-inset flex h-8 w-full items-center justify-between gap-3 rounded-md px-2.5 text-left text-sm transition-colors hover:bg-hover aria-[current=true]:bg-selected aria-[current=true]:font-medium';

function ProviderItem({ provider, current, onSelect, showReadiness }: { provider: Provider; current: boolean; onSelect: () => void; showReadiness: boolean }) {
  return (
    <li>
      <button type="button" aria-current={current ? 'true' : undefined} onClick={onSelect} title={provider.name} className={cn(itemClass, !provider.enabled && 'text-muted-foreground')}>
        <span className="truncate">{provider.name}</span>
        {showReadiness ? <StatusLabel status={READINESS[provider.readiness]} className="shrink-0 text-xs font-normal text-muted-foreground" /> : null}
      </button>
    </li>
  );
}

/** Registry-published registrar lists: one collapsed row that opens into a searchable list. */
function DirectoryList({ entries, selectedId, onSelect }: { entries: Provider[]; selectedId: string | undefined; onSelect: (id: string) => void }) {
  const id = useId();
  const containsSelected = entries.some((p) => p.id === selectedId);
  const [open, setOpen] = useState(containsSelected);
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const shown = query ? entries.filter((p) => p.name.toLowerCase().includes(query)) : entries;
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        onClick={() => setOpen((v) => !v)}
        className="focus-inset flex h-8 w-full items-center gap-1.5 rounded-md px-2.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
      >
        <ChevronRight aria-hidden className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="truncate">Registry directories</span>
        <span className="ml-auto font-mono tabular">{formatCount(entries.length)}</span>
      </button>
      {open ? (
        <div id={`${id}-list`} className="mt-1 flex flex-col gap-1">
          <div className="relative px-0.5">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" aria-label="Search registry directories" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          {shown.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">No registrar matches.</p>
          ) : (
            <ul className="flex flex-col">
              {shown.map((provider) => (
                <ProviderItem
                  key={provider.id}
                  provider={provider}
                  current={provider.id === selectedId}
                  onSelect={() => onSelect(provider.id)}
                  showReadiness={provider.readiness !== 'keyless'}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
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
  const registrars = list.filter((p) => p.kind === 'registrar');
  const directory = list.filter((p) => p.kind === 'directory');

  return (
    <Page>
      <PageHeader
        title="Providers"
        meta={
          providers.data ? (
            <span className="text-muted-foreground">
              <span className="font-mono tabular">{formatCount(registrars.length)}</span> registrars
              {directory.length ? (
                <>
                  {' · '}
                  <span className="font-mono tabular">{formatCount(directory.length)}</span> from registry directories
                </>
              ) : null}
            </span>
          ) : null
        }
      />
      {providers.isPending ? (
        <div className="grid gap-8 md:grid-cols-[14rem_minmax(0,1fr)]">
          <SkeletonRows rows={9} />
          <SkeletonRows rows={9} />
        </div>
      ) : providers.isError ? (
        <ErrorState error={providers.error} onRetry={() => providers.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState>No providers.</EmptyState>
      ) : (
        <div className="flex flex-col gap-6 md:flex-row md:gap-8 lg:min-h-0 lg:flex-1">
          <nav aria-label="Providers" className={cn('relative -mx-1 flex flex-col px-1 md:w-60 md:shrink-0 lg:min-h-0 lg:overflow-y-auto', selectedId && 'max-md:hidden')}>
            <p className="mb-1 px-2.5 text-xs font-medium text-muted-foreground">Registrars</p>
            <ul className="flex flex-col">
              {registrars.map((provider) => (
                <ProviderItem key={provider.id} provider={provider} current={selected?.id === provider.id} onSelect={() => select(provider.id)} showReadiness />
              ))}
            </ul>
            {directory.length > 0 ? <DirectoryList entries={directory} selectedId={selected?.id} onSelect={select} /> : null}
          </nav>
          <div className={cn('relative -mx-1 min-w-0 flex-1 px-1 lg:min-h-0 lg:overflow-y-auto', !selectedId && 'max-md:hidden')}>
            {selectedId ? (
              <Button size="sm" variant="quiet" className="-ml-2 mb-2 md:hidden" onClick={() => select(null)}>
                <ArrowLeft />
                Providers
              </Button>
            ) : null}
            {selected ? <ProviderDetail key={selected.id} provider={selected} /> : <EmptyState>{humanize(selectedId ?? 'provider')} not found.</EmptyState>}
          </div>
        </div>
      )}
    </Page>
  );
}
