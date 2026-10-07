'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, ChevronRight, ExternalLink, Eye, ListPlus, Maximize2, RotateCw, Search, ShoppingBag, Tag } from 'lucide-react';
import type { DomainEvidence, RegistryObservation } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import {
  DESTINATION_NOTE,
  LISTING_STATUS,
  NOT_REGISTERED_HINT,
  PRICE_KIND,
  confirmationStatus,
  diagnosticStatus,
  humanize,
  nameCheckStatus,
  registryStatus,
} from '@/lib/labels';
import { formatDate, formatDateTime, formatMoney, plural } from '@/lib/format';
import { type PriceLine, buyUrl, cheapestLine, linkOnlyProviders, priceLines, useEnabledProviders, useHorizon, usePriceCurrency, useSuffixPrices } from '@/lib/prices';
import { useNow } from '@/lib/use-now';
import { qk, useCollections, useProviders } from '@/lib/queries';
import { defaultListOf, useQuickSave, useQuickWatch, useWatchIndex } from '@/lib/saved';
import { useIdempotency } from '@/lib/use-idempotency';
import { isTerminal, useLiveJob } from '@/lib/use-job';
import { cn } from '@/lib/utils';
import { Disclosure, joinNames } from '../actions/disclosure';
import { DiagnosticsDialog, NameCheckDialog } from '../actions/enrichment-dialogs';
import { ProviderRequestDialog } from '../actions/provider-request-dialog';
import { ShortlistDialog } from '../actions/shortlist-dialog';
import { BackButton } from '../back-button';
import { PriceChart, primaryField } from '../history/price-chart';
import { ErrorState, Facts, Page } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dock } from '../ui/dock';
import { Skeleton, SkeletonRows } from '../ui/skeleton';
import { Tooltip } from '../ui/tooltip';
import { RelativeTime, useFreshness } from './time';

type SectionId = 'registry' | 'other' | 'checks' | 'history';

function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[13px]', className)}>{children}</span>;
}

function OutLink({ href, children, label }: { href: string; children: React.ReactNode; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm underline-offset-4 hover:underline">
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only"> {label} (opens in a new tab)</span>
    </a>
  );
}

/** A collapsed group of secondary detail under the decision. */
function Collapsible({ id, title, count, open, onToggle, children }: { id: string; title: string; count?: number; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  const contentId = useId();
  return (
    <section aria-label={title} className="min-w-0" data-section={id}>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={onToggle}
          className="flex h-9 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-sm font-medium transition-colors hover:bg-hover"
        >
          <ChevronRight aria-hidden className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-90')} />
          {title}
          {count ? <span className="font-normal text-muted-foreground tabular">{count}</span> : null}
        </button>
      </h3>
      {open ? (
        <div id={contentId} className="px-1.5 pb-3 pt-1">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function useDomainData(name: string) {
  const evidence = useQuery({
    queryKey: qk.evidence(name),
    queryFn: ({ signal }) => api.call('getDomainEvidence', { params: { name }, signal }).then((r) => r.data),
  });
  const offers = useQuery({
    queryKey: [...qk.evidence(name), 'offers'],
    queryFn: ({ signal }) => api.call('listDomainOffers', { params: { name }, query: { limit: 200 }, signal }).then((r) => r.data),
  });
  const providers = useProviders();
  const suffix = evidence.data?.suffix ?? name.split('.').slice(1).join('.');
  const horizon = useHorizon();
  const prices = useSuffixPrices(suffix ? [suffix] : [], horizon);
  const names = new Map((providers.data ?? []).map((p) => [p.id, p.name]));
  for (const p of evidence.data?.providers ?? []) if (!names.has(p.providerId)) names.set(p.providerId, p.name);
  // The shared clock re-runs this as quotes reach their expiry, so an expired quote stops being offered.
  const now = useNow();
  const enabled = useEnabledProviders();
  const lines = priceLines(name, prices.map.get(suffix), offers.data ?? [], horizon, names, { now, enabled });
  return { evidence, offers, providers, prices, suffix, horizon, names, lines };
}

/** Recheck one domain; the evidence refreshes when the check finishes. */
function useRecheck(name: string) {
  const client = useQueryClient();
  const idempotency = useIdempotency();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useLiveJob(jobId);
  const done = isTerminal(job.data);
  useEffect(() => {
    if (!jobId || !done) return;
    void client.invalidateQueries({ queryKey: qk.evidence(name) });
    // Saved lists read the latest evidence through their own entries query.
    void client.invalidateQueries({ queryKey: ['collectionEntries'] });
  }, [client, name, jobId, done]);
  const start = useMutation({
    mutationFn: async () => {
      const body = { domains: [name], label: `Check again: ${name}` };
      return (await api.call('createRecheck', { body, idempotencyKey: idempotency.keyFor(body) })).data;
    },
    onSuccess: (created) => {
      idempotency.reset();
      setJobId(created.id);
    },
  });
  return { run: () => start.mutate(), running: start.isPending || Boolean(jobId && job.data && !done) };
}

function StatusLine({ latest, name }: { latest: RegistryObservation | undefined; name: string }) {
  const freshness = useFreshness(latest?.freshness ?? null, latest?.staleAt);
  const recheck = useRecheck(name);
  const stale = !latest || freshness !== 'fresh' || !['registered', 'no_record'].includes(latest.outcome);
  const status = latest ? registryStatus(latest.outcome) : { label: 'Not checked yet', tone: 'muted' as const, unresolved: true };
  const label = <StatusLabel status={status} className="text-[15px] font-medium" />;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1" data-testid="domain-status">
      {latest?.outcome === 'no_record' ? <Tooltip content={NOT_REGISTERED_HINT}><span className="inline-flex">{label}</span></Tooltip> : label}
      {latest ? (
        <span className="text-sm text-muted-foreground">
          checked <RelativeTime iso={latest.checkedAt} />
        </span>
      ) : null}
      {stale || recheck.running ? (
        <Button size="sm" variant="ghost" className="-ml-1 h-7 px-2" disabled={recheck.running} onClick={recheck.run}>
          <RotateCw className={cn(recheck.running && 'motion-safe:animate-spin')} />
          {recheck.running ? 'Checking' : 'Recheck'}
        </Button>
      ) : null}
    </div>
  );
}

function TakenFacts({ latest }: { latest: RegistryObservation }) {
  const reg = latest.registration;
  if (!reg) return null;
  const parts = [reg.registrar, reg.expiresAt ? `expires ${formatDate(reg.expiresAt)}` : null, reg.createdAt ? `since ${formatDate(reg.createdAt)}` : null].filter(Boolean);
  return parts.length ? <p className="text-sm text-muted-foreground">{parts.join(' · ')}</p> : null;
}

const priceGrid = 'grid grid-cols-[minmax(0,1fr)_4.75rem_4.75rem_5.25rem_3.5rem] items-center gap-x-3';

function PriceTable({ lines, horizon }: { lines: PriceLine[]; horizon: number }) {
  return (
    <div role="table" aria-label="Prices" className="text-sm">
      <div role="row" className={cn(priceGrid, 'h-7 px-2 text-xs text-muted-foreground')}>
        <span role="columnheader">Provider</span>
        <span role="columnheader" className="text-right">
          First year
        </span>
        <span role="columnheader" className="text-right">
          Renews
        </span>
        <span role="columnheader" className="text-right">
          {horizon} years
        </span>
        <span role="columnheader">
          <span className="sr-only">Buy</span>
        </span>
      </div>
      {lines.map((line, index) => (
        <div key={line.providerId} role="row" className={cn(priceGrid, 'min-h-10 rounded-md px-2 py-1', index === 0 && line.firstYear ? 'bg-background' : 'hover:bg-hover')} data-testid="price-row">
          <span role="cell" className="min-w-0">
            <span className="block truncate font-medium">{line.providerName}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {PRICE_KIND[line.kind]}
              {line.kind === 'exact_quote' ? (
                <>
                  {' '}
                  <RelativeTime iso={line.observedAt} />
                </>
              ) : null}
              {line.minYears ? ` · ${line.minYears} year minimum` : line.firstYearTerm > 1 ? ` · ${line.firstYearTerm} year minimum` : ''}
            </span>
            {line.promotionNote ? <span className="block truncate text-xs text-muted-foreground" title={line.promotionNote}>Promotion: {line.promotionNote}</span> : line.promotional ? <span className="block text-xs text-muted-foreground">Promotion</span> : null}
          </span>
          <span role="cell" className="text-right font-semibold tabular">
            {line.firstYear ? formatMoney(line.firstYear, line.currency) : <span className="font-normal text-muted-foreground">Unknown</span>}
            {line.firstYear && line.firstYearTerm > 1 ? <span className="text-[11px] font-normal text-muted-foreground"> /{line.firstYearTerm} yr</span> : null}
          </span>
          <span role="cell" className="text-right text-muted-foreground tabular">
            {line.renewal ? formatMoney(line.renewal, line.currency) : 'Unknown'}
            {line.renewal && line.renewalTerm > 1 ? <span className="text-[11px]"> /{line.renewalTerm} yr</span> : null}
          </span>
          <span role="cell" className="text-right tabular">
            {line.horizonTotal ? formatMoney(line.horizonTotal, line.currency) : <span className="text-muted-foreground">Unknown</span>}
          </span>
          <span role="cell" className="flex justify-end">
            {line.url ? (
              <a
                href={line.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="buy-link"
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] font-medium transition-colors hover:bg-selected"
              >
                Buy
                <ExternalLink aria-hidden className="size-3" />
                <span className="sr-only"> at {line.providerName} (opens in a new tab)</span>
              </a>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

type EvidenceProvider = DomainEvidence['providers'][number];

function RegistrarLink({ provider, domain }: { provider: { name: string; url: string | null; kind: string | null }; domain: string }) {
  const kind = provider.kind ?? 'website';
  return (
    <li className="flex min-h-8 items-center justify-between gap-3 rounded-md px-1.5 text-sm hover:bg-hover">
      <span className="min-w-0 truncate">{provider.name}</span>
      {provider.url ? (
        <span className="flex shrink-0 items-center gap-2 text-xs">
          {DESTINATION_NOTE[kind] ? <span className="text-muted-foreground">{DESTINATION_NOTE[kind]}</span> : null}
          <OutLink href={provider.url} label={`${provider.name} for ${domain}`}>
            {kind === 'website' ? 'Website' : kind === 'dashboard' ? 'Sign in' : 'Open'}
          </OutLink>
        </span>
      ) : null}
    </li>
  );
}

/**
 * Where else the name can be bought: named registrars without a published price, then the sellers the
 * registry lists, collapsed behind their count with a search.
 */
function OtherRegistrars({ domain, suffix, priced, sellers }: { domain: string; suffix: string; priced: Set<string>; sellers: EvidenceProvider[] }) {
  const providers = useProviders();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  // Evidence names this suffix's sellers with links built by the backend; older data falls back to the provider list.
  const fromEvidence = sellers.length > 0;
  const fallback = linkOnlyProviders(providers.data, suffix, priced);
  const named = fromEvidence
    ? sellers
        .filter((p) => p.kind === 'registrar' && p.enabled && !priced.has(p.providerId) && p.purchaseUrl && p.supportsSuffix !== 'no')
        .sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.name.localeCompare(b.name))
        .map((p) => ({ id: p.providerId, name: p.name, url: p.purchaseUrl, kind: p.purchaseKind }))
    : fallback.named.map((p) => ({ id: p.id, name: p.name, url: buyUrl(p.purchaseLink?.template, domain), kind: p.purchaseLink?.kind ?? null }));
  const directory = fromEvidence
    ? sellers
        .filter((p) => p.kind === 'directory' && p.enabled && p.purchaseUrl)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ id: p.providerId, name: p.name, url: p.purchaseUrl, kind: p.purchaseKind ?? 'website' }))
    : fallback.directory.map((p) => ({ id: p.id, name: p.name, url: buyUrl(p.purchaseLink?.template, domain), kind: p.purchaseLink?.kind ?? 'website' }));
  if (named.length === 0 && directory.length === 0) return null;
  const query = q.trim().toLowerCase();
  const shown = query ? directory.filter((p) => p.name.toLowerCase().includes(query)) : directory;
  return (
    <div className="mt-2 flex flex-col gap-1">
      {named.length ? (
        <div>
          <p className="px-1.5 pb-0.5 text-xs text-muted-foreground">No published price</p>
          <ul aria-label={`Other registrars for .${suffix}`}>
            {named.map((p) => (
              <RegistrarLink key={p.id} provider={p} domain={domain} />
            ))}
          </ul>
        </div>
      ) : null}
      {directory.length ? (
        <div>
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex h-8 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-hover hover:text-foreground">
            <ChevronRight aria-hidden className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
            {plural(directory.length, named.length ? 'more accredited seller' : 'accredited seller')} listed by the .{suffix} registry
          </button>
          {open ? (
            <div className="mt-1 flex flex-col gap-1.5">
              {directory.length > 8 ? (
                <div className="relative">
                  <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="search"
                    aria-label="Search sellers"
                    placeholder="Search sellers"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    className="h-8 w-full rounded-md bg-input pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground"
                  />
                </div>
              ) : null}
              <ul aria-label={`Sellers listed by the .${suffix} registry`} className="relative max-h-64 overflow-y-auto">
                {shown.map((p) => (
                  <RegistrarLink key={p.id} provider={p} domain={domain} />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Whether any enabled provider can return exact quotes right now. */
function useCanQuote() {
  const providers = useProviders();
  return (providers.data ?? []).some(
    (p) => p.enabled && p.capabilities.quote.level !== 'unsupported' && (!p.capabilities.quote.requiresCredentials || p.credentials.configured),
  );
}

function MonoList({ values }: { values: string[] }) {
  if (values.length === 0) return <span className="text-muted-foreground">None returned</span>;
  return (
    <ul className="flex flex-col font-mono text-[13px]">
      {values.map((value) => (
        <li key={value} className="break-all">
          {value}
        </li>
      ))}
    </ul>
  );
}

function RawResponse({ observationId }: { observationId: string }) {
  const [open, setOpen] = useState(false);
  const raw = useQuery({
    queryKey: ['raw', observationId],
    queryFn: ({ signal }) => api.call('getRawDiagnostic', { params: { id: observationId }, signal }).then((r) => r.data),
    enabled: open,
    staleTime: Infinity,
  });
  return (
    <div className="mt-2">
      <Button size="sm" variant="ghost" className="-ml-2" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide raw response' : 'Show raw response'}
      </Button>
      {open ? (
        raw.isPending ? (
          <Skeleton className="mt-2 h-32" />
        ) : raw.isError ? (
          <ErrorState error={raw.error} className="mt-2" />
        ) : (
          <div className="mt-2">
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-input p-3 font-mono text-xs leading-relaxed">{raw.data.body}</pre>
            <p className="mt-1 text-xs text-muted-foreground">
              {raw.data.contentType ?? 'Unknown content type'}
              {raw.data.truncated ? ' · truncated' : ''}
            </p>
          </div>
        )
      ) : null}
    </div>
  );
}

const ROUTING: Record<string, string> = { iana_bootstrap: 'IANA bootstrap', curated: 'Curated' };

function RegistryDetails({ evidence, names }: { evidence: DomainEvidence; names: Map<string, string> }) {
  const [latest, ...older] = evidence.registry;
  if (!latest) return <p className="text-sm text-muted-foreground">No registry evidence yet.</p>;
  const reg = latest.registration;
  const facts: [React.ReactNode, React.ReactNode][] = [];
  if (reg) {
    facts.push(
      ['Registrar', reg.registrar ?? <span className="text-muted-foreground">Unknown</span>],
      ['Created', formatDate(reg.createdAt)],
      ['Updated', formatDate(reg.updatedAt)],
      ['Registry expiry', formatDate(reg.expiresAt)],
      ['Statuses', <MonoList key="s" values={reg.statuses} />],
      ['Nameservers', <MonoList key="n" values={reg.nameservers} />],
      ['DNSSEC', reg.dnssec === null ? 'Unknown' : reg.dnssec ? 'Signed' : 'Unsigned'],
    );
  }
  facts.push(
    ['Checked', formatDateTime(latest.checkedAt)],
    ['Source', latest.source ? <span key="src"><Mono>{latest.source.registryId}</Mono> <span className="text-muted-foreground">{latest.source.protocol.toUpperCase()}</span></span> : 'Not queried'],
    ['Destination', latest.source ? <Mono key="d" className="break-all">{latest.source.destination}</Mono> : 'None'],
    ['Routing', latest.source ? (ROUTING[latest.source.routing] ?? humanize(latest.source.routing)) : 'None'],
    ['Reason', latest.reason.message],
    [
      'Eligibility',
      <span key="e">
        {humanize(latest.eligibility.status)}
        {latest.eligibility.source ? <span className="text-muted-foreground"> · {latest.eligibility.source}</span> : null}
      </span>,
    ],
  );
  if (latest.matchedName) facts.push(['Matched name', <Mono key="m">{latest.matchedName}</Mono>]);
  if (latest.httpStatus !== null) facts.push(['HTTP status', <Mono key="h">{latest.httpStatus}</Mono>]);
  if (latest.reused) facts.push(['Cache', 'Reused an earlier answer']);
  if (latest.retryAt) facts.push(['Retry after', <RelativeTime key="r" iso={latest.retryAt} />]);
  return (
    <div className="flex flex-col gap-4">
      <Facts items={facts} />
      {latest.hasRawDiagnostics ? <RawResponse observationId={latest.id} /> : null}
      {evidence.confirmations.length ? (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Provider confirmations</p>
          <ul className="flex flex-col gap-1.5 text-sm">
            {evidence.confirmations.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{names.get(c.providerId) ?? c.providerId}</span>
                <StatusLabel status={confirmationStatus(c.status)} />
                <RelativeTime iso={c.checkedAt} className="text-xs text-muted-foreground" />
                <span className="w-full text-xs text-muted-foreground">{c.reason.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {older.length ? (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Earlier checks</p>
          <ul className="flex flex-col gap-1 text-sm">
            {older.map((o) => (
              <li key={o.id} className="flex flex-wrap items-baseline gap-x-3">
                <StatusLabel status={registryStatus(o.outcome)} className="w-32" />
                <span className="text-muted-foreground">{formatDateTime(o.checkedAt)}</span>
                <Mono className="text-muted-foreground">{o.source ? `${o.source.protocol.toUpperCase()} ${o.source.registryId}` : 'Not queried'}</Mono>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function OtherWaysToBuy({ name, names }: { name: string; names: Map<string, string> }) {
  const client = useQueryClient();
  const idempotency = useIdempotency();
  const [transferOpen, setTransferOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [jobId, setJobId] = useState<string | null>(null);
  const transfers = useQuery({
    queryKey: qk.transferOptions(name),
    queryFn: ({ signal }) => api.call('listDomainTransferOptions', { params: { name }, query: { limit: 100 }, signal }).then((r) => r.data),
  });
  const listings = useQuery({
    queryKey: qk.listings(name),
    queryFn: ({ signal }) => api.call('listDomainListings', { params: { name }, query: { limit: 100 }, signal }).then((r) => r.data),
  });
  const sources = useQuery({
    queryKey: qk.aftermarketSources,
    queryFn: ({ signal }) => api.call('listAftermarketSources', { signal }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const job = useLiveJob(jobId);
  const done = isTerminal(job.data);
  useEffect(() => {
    if (jobId && done) void client.invalidateQueries({ queryKey: qk.listings(name) });
  }, [client, name, jobId, done]);
  const supported = (sources.data ?? []).filter((s) => s.supported);
  const linkOnly = (sources.data ?? []).filter((s) => !s.supported && s.searchUrlTemplate);
  const selected = supported.filter((s) => chosen.has(s.id));
  const lookup = useMutation({
    mutationFn: async () => {
      const body = { domains: [name], sources: selected.map((s) => s.id) };
      return (await api.call('createAftermarket', { body, idempotencyKey: idempotency.keyFor(body) })).data;
    },
    onSuccess: (created) => {
      idempotency.reset();
      setJobId(created.id);
    },
  });
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">Transfer</p>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setTransferOpen(true)}>
            Request transfer prices
          </Button>
        </div>
        {transfers.isPending ? (
          <SkeletonRows rows={2} />
        ) : transfers.isError ? (
          <ErrorState error={transfers.error} onRetry={() => transfers.refetch()} />
        ) : transfers.data.length === 0 ? (
          <p className="text-muted-foreground">No transfer prices retained.</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="transfer-options">
            {transfers.data.map((option) => (
              <li key={`${option.providerId}-${option.observedAt}`} className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-medium">{names.get(option.providerId) ?? option.providerId}</span>
                <span className="tabular">{option.transfer ? formatMoney(option.transfer.amount, option.transfer.currency) : 'Unknown'}</span>
                <span className="text-xs text-muted-foreground">
                  {option.includesYears === null ? 'included term unknown' : option.includesYears === 0 ? 'no year included' : `includes ${plural(option.includesYears, 'year')}`}
                  {option.renewal ? ` · renews ${formatMoney(option.renewal.amount, option.renewal.currency)}` : ''} · {PRICE_KIND[option.kind]} <RelativeTime iso={option.observedAt} />
                </span>
                {option.destination ? (
                  <OutLink href={option.destination} label={names.get(option.providerId) ?? option.providerId}>
                    Transfer page
                  </OutLink>
                ) : null}
                {option.eligibility.known.length ? <span className="w-full font-mono text-xs text-muted-foreground">{option.eligibility.known.join(', ')}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Aftermarket</p>
        {listings.isPending ? (
          <SkeletonRows rows={2} />
        ) : listings.isError ? (
          <ErrorState error={listings.error} onRetry={() => listings.refetch()} />
        ) : listings.data.length === 0 ? (
          <p className="text-muted-foreground">No listings retained.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {listings.data.map((listing) => (
              <li key={listing.id} className="flex flex-wrap items-baseline gap-x-3" data-testid="listing">
                <span className="font-medium">{listing.marketplace}</span>
                <StatusLabel status={LISTING_STATUS[listing.status] ?? { label: humanize(listing.status), tone: 'muted' }} />
                <span className="tabular">{listing.price ? `${formatMoney(listing.price.amount, listing.price.currency)} asking` : 'Price unknown'}</span>
                <RelativeTime iso={listing.observedAt} className="text-xs text-muted-foreground" />
                {listing.url ? (
                  <OutLink href={listing.url} label={listing.marketplace}>
                    Listing
                  </OutLink>
                ) : null}
                <span className="w-full text-xs text-muted-foreground">{listing.caveat}</span>
              </li>
            ))}
          </ul>
        )}
        {linkOnly.length ? (
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            <span className="text-muted-foreground">Search</span>
            {linkOnly.map((s) => (
              <OutLink key={s.id} href={s.searchUrlTemplate!.replaceAll('{domain}', encodeURIComponent(name))} label={s.name}>
                {s.name}
              </OutLink>
            ))}
          </p>
        ) : null}
        {supported.length ? (
          <div className="mt-3 flex flex-col gap-1">
            {supported.map((source) => (
              <label key={source.id} htmlFor={`am-${source.id}`} className="-mx-1.5 flex min-h-8 items-center gap-2.5 rounded-md px-1.5 hover:bg-hover">
                <Checkbox
                  id={`am-${source.id}`}
                  checked={chosen.has(source.id)}
                  onCheckedChange={(v) =>
                    setChosen((current) => {
                      const next = new Set(current);
                      if (v === true) next.add(source.id);
                      else next.delete(source.id);
                      return next;
                    })
                  }
                />
                <span className="flex-1">{source.name}</span>
                {source.requiresCredentials ? <span className="text-xs text-muted-foreground">Needs credentials</span> : null}
              </label>
            ))}
            {selected.length ? (
              <Disclosure>Sends {name} to {joinNames(selected.map((s) => (s.apiHosts.length ? `${s.name} (${s.apiHosts.join(', ')})` : s.name)))}.</Disclosure>
            ) : null}
            <div className="mt-1">
              <Button size="sm" variant="secondary" disabled={selected.length === 0 || lookup.isPending || Boolean(jobId && !done)} onClick={() => lookup.mutate()}>
                Look up listings
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <ProviderRequestDialog open={transferOpen} onOpenChange={setTransferOpen} target={{ count: 1, resolveDomains: async () => [name] }} defaultOperation="transfer" />
    </div>
  );
}

function Checks({ evidence, name }: { evidence: DomainEvidence; name: string }) {
  const [dialog, setDialog] = useState<'names' | 'diagnostics' | null>(null);
  const target = { count: 1, resolveDomains: async () => [name] };
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => setDialog('names')}>
          Run name checks
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setDialog('diagnostics')}>
          Run diagnostics
        </Button>
      </div>
      {evidence.nameChecks.length ? (
        <ul className="flex flex-col gap-1.5" aria-label="Name checks">
          {evidence.nameChecks.map((check) => (
            <li key={check.id} className="flex flex-wrap items-baseline gap-x-3">
              <span className="font-medium">{humanize(check.service)}</span>
              <Mono>{check.name}</Mono>
              <StatusLabel status={nameCheckStatus(check.outcome)} />
              <RelativeTime iso={check.checkedAt} className="text-xs text-muted-foreground" />
            </li>
          ))}
        </ul>
      ) : null}
      {evidence.diagnostics.length ? (
        <ul className="flex flex-col gap-2" aria-label="Diagnostics">
          {evidence.diagnostics.map((d) => (
            <li key={d.id}>
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-medium">{humanize(d.check)}</span>
                <StatusLabel status={diagnosticStatus(d.outcome)} />
                <Mono className="text-muted-foreground">{d.destination}</Mono>
                <RelativeTime iso={d.checkedAt} className="text-xs text-muted-foreground" />
              </div>
              <p className="text-xs text-muted-foreground">{d.reason.message}</p>
              {Object.keys(d.data).length ? (
                <details className="mt-1">
                  <summary className="w-fit cursor-pointer rounded-sm text-xs text-muted-foreground hover:text-foreground">Observed data</summary>
                  <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-input p-2.5 font-mono text-xs">{JSON.stringify(d.data, null, 2)}</pre>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!evidence.nameChecks.length && !evidence.diagnostics.length ? <p className="text-muted-foreground">No checks yet.</p> : null}
      <NameCheckDialog open={dialog === 'names'} onOpenChange={(o) => setDialog(o ? 'names' : null)} target={target} />
      <DiagnosticsDialog open={dialog === 'diagnostics'} onOpenChange={(o) => setDialog(o ? 'diagnostics' : null)} target={target} />
    </div>
  );
}

function PriceHistory({ suffix, names }: { suffix: string; names: Map<string, string> }) {
  const history = useQuery({
    queryKey: qk.priceHistory({ suffix, limit: 4 }),
    queryFn: ({ signal }) => api.call('getPriceHistory', { query: { suffix, limit: 4 }, signal }).then((r) => r.data),
  });
  if (history.isPending) return <SkeletonRows rows={3} />;
  if (history.isError) return <ErrorState error={history.error} onRetry={() => history.refetch()} />;
  if (history.data.length === 0) return <p className="text-sm text-muted-foreground">No price observations for .{suffix} yet.</p>;
  return (
    <div className="flex flex-col gap-5">
      {history.data.map((series) => (
        <div key={series.key} data-testid="price-series">
          <p className="mb-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{names.get(series.providerId) ?? series.providerId}</span> · {humanize(series.purchasePath)} · {PRICE_KIND[series.kind]}
            {series.promotional ? ' · promotion' : ''}
          </p>
          <PriceChart series={series} field={primaryField(series)} />
        </div>
      ))}
      <Link href={`/settings/prices?suffix=${encodeURIComponent(suffix)}`} className="w-fit rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        All price history for .{suffix}
      </Link>
    </div>
  );
}

/**
 * Decision first: status and freshness, where to buy at what cost over time, then save and watch.
 * Registry evidence, other purchase paths, checks and price history wait one click below.
 */
function DomainBody({ name, open, onToggle }: { name: string; open: Set<SectionId>; onToggle: (id: SectionId) => void }) {
  const data = useDomainData(name);
  const { evidence, lines, horizon, suffix, names } = data;
  const currency = usePriceCurrency();
  const collections = useCollections();
  const quickSave = useQuickSave();
  const quickWatch = useQuickWatch();
  const watches = useWatchIndex();
  const canQuote = useCanQuote();
  const [dialog, setDialog] = useState<'quote' | 'list' | null>(null);

  if (evidence.isPending) {
    return (
      <div className="px-4 pt-3">
        <SkeletonRows rows={6} />
      </div>
    );
  }
  if (evidence.isError) {
    return (
      <div className="px-4 pt-3">
        <ErrorState error={evidence.error} onRetry={() => evidence.refetch()} />
      </div>
    );
  }
  const ev = evidence.data;
  const latest = ev.registry[0];
  const taken = latest?.outcome === 'registered';
  const free = latest?.outcome === 'no_record';
  const cheapest = cheapestLine(lines, currency);
  const defaultList = defaultListOf(collections.data);
  const inDefault = Boolean(defaultList && ev.collections.some((c) => c.id === defaultList.id));
  const watch = watches.index.get(name);
  const target = { count: 1, resolveDomains: async () => [name] };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6">
      <div className="flex flex-col gap-1.5 pt-1">
        <StatusLine latest={latest} name={name} />
        {taken && latest ? <TakenFacts latest={latest} /> : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {free && cheapest?.url ? (
          <Button size="sm" variant="primary" asChild>
            <a href={cheapest.url} target="_blank" rel="noopener noreferrer" data-testid="buy-cheapest">
              <ShoppingBag />
              Buy at {cheapest.providerName}
              {cheapest.firstYear ? <span className="font-normal opacity-80">{formatMoney(cheapest.firstYear, cheapest.currency)}</span> : null}
            </a>
          </Button>
        ) : null}
        <Button size="sm" variant={inDefault ? 'primary' : 'secondary'} aria-pressed={inDefault} disabled={quickSave.isPending} onClick={() => quickSave.mutate({ domains: [name], save: !inDefault })}>
          <Bookmark className={cn(inDefault && 'fill-current')} />
          {inDefault ? 'Saved' : 'Save'}
        </Button>
        {watch ? (
          <Button size="sm" variant="secondary" asChild>
            <Link href={`/watching/${watch.id}`}>
              <Eye />
              Watching
            </Link>
          </Button>
        ) : (
          <Button size="sm" variant={taken ? 'primary' : 'secondary'} disabled={quickWatch.isPending} onClick={() => quickWatch.mutate(name)}>
            <Eye />
            Watch
          </Button>
        )}
        <Tooltip content="Add to a list">
          <Button size="icon-sm" variant="ghost" aria-label="Add to a list" onClick={() => setDialog('list')}>
            <ListPlus />
          </Button>
        </Tooltip>
      </div>
      {ev.collections.length ? (
        <p className="mt-2 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          In
          {ev.collections.map((c, i) => (
            <span key={c.id}>
              <Link href={`/saved/${c.id}`} className="text-foreground underline-offset-4 hover:underline">
                {c.name}
              </Link>
              {i < ev.collections.length - 1 ? ',' : ''}
            </span>
          ))}
        </p>
      ) : null}

      {!taken ? (
        <section aria-label="Prices" className="mt-5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Prices</h3>
            {canQuote ? (
              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setDialog('quote')}>
                <Tag />
                Get exact quotes
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">
                Exact quotes need provider keys.{' '}
                <Link href="/settings/providers" className="text-foreground underline-offset-4 hover:underline">
                  Providers
                </Link>
              </span>
            )}
          </div>
          {data.prices.isPending || data.offers.isPending ? (
            <SkeletonRows rows={3} />
          ) : lines.length ? (
            <div className="-mx-2 rounded-lg bg-input/60 p-1">
              <PriceTable lines={lines} horizon={horizon} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No provider price is known for .{suffix}.</p>
          )}
          {lines.length ? <p className="mt-1.5 text-xs text-muted-foreground">Published prices are per extension. Premium names and taxes can differ.</p> : null}
          <OtherRegistrars domain={name} suffix={suffix} priced={new Set(lines.map((l) => l.providerId))} sellers={ev.providers} />
        </section>
      ) : null}

      <div className="mt-5 flex flex-col">
        <Collapsible id="registry" title="Registry details" open={open.has('registry')} onToggle={() => onToggle('registry')}>
          <RegistryDetails evidence={ev} names={names} />
        </Collapsible>
        <Collapsible id="other" title="Other ways to buy" count={ev.listings.length || undefined} open={open.has('other')} onToggle={() => onToggle('other')}>
          <OtherWaysToBuy name={name} names={names} />
        </Collapsible>
        <Collapsible id="checks" title="Checks" count={ev.nameChecks.length + ev.diagnostics.length || undefined} open={open.has('checks')} onToggle={() => onToggle('checks')}>
          <Checks evidence={ev} name={name} />
        </Collapsible>
        <Collapsible id="history" title="Price history" open={open.has('history')} onToggle={() => onToggle('history')}>
          <PriceHistory suffix={suffix} names={names} />
        </Collapsible>
      </div>

      <ProviderRequestDialog open={dialog === 'quote'} onOpenChange={(o) => setDialog(o ? 'quote' : null)} target={target} />
      <ShortlistDialog open={dialog === 'list'} onOpenChange={(o) => setDialog(o ? 'list' : null)} target={target} />
    </div>
  );
}

function DomainTitle({ name, unicode, className }: { name: string; unicode: string | undefined; className?: string }) {
  const showUnicode = unicode && unicode !== name;
  return (
    <span className={cn('min-w-0 break-all', className)}>
      {showUnicode ? unicode : name}
      {showUnicode ? <span className="ml-2 text-sm font-normal text-muted-foreground">{name}</span> : null}
    </span>
  );
}

function useOpenSections() {
  const [open, setOpen] = useState<Set<SectionId>>(new Set());
  return {
    open,
    toggle: (id: SectionId) =>
      setOpen((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
  };
}

/** Domain details docked beside results or a list. Open sections stay open while rows change. */
export function DomainDock({ name, onClose }: { name: string; onClose: () => void }) {
  const sections = useOpenSections();
  const evidence = useQuery({
    queryKey: qk.evidence(name),
    queryFn: ({ signal }) => api.call('getDomainEvidence', { params: { name }, signal }).then((r) => r.data),
  });
  return (
    <Dock
      label={name}
      onClose={onClose}
      header={
        <h2 className="flex min-h-control items-center text-base font-semibold tracking-tight">
          <DomainTitle name={name} unicode={evidence.data?.unicode} />
        </h2>
      }
      actions={
        <Button size="icon-sm" variant="quiet" asChild>
          <Link href={`/domains/${encodeURIComponent(name)}`} aria-label="Open full page">
            <Maximize2 />
          </Link>
        </Button>
      }
    >
      <DomainBody key={name} name={name} open={sections.open} onToggle={sections.toggle} />
    </Dock>
  );
}

/** The shareable full page for one domain: the same decision-first content in the page frame. */
export function DomainPage({ name }: { name: string }) {
  const sections = useOpenSections();
  const evidence = useQuery({
    queryKey: qk.evidence(name),
    queryFn: ({ signal }) => api.call('getDomainEvidence', { params: { name }, signal }).then((r) => r.data),
  });
  return (
    <Page className="items-center">
      <div className="flex w-full max-w-3xl flex-col gap-2 lg:min-h-0 lg:flex-1">
        <div className="flex items-center gap-2">
          <BackButton fallback="/" />
        </div>
        <h1 className="px-4 text-xl font-semibold tracking-tight">
          <DomainTitle name={name} unicode={evidence.data?.unicode} />
        </h1>
        <div className="flex min-h-0 flex-1 flex-col">
          <DomainBody name={name} open={sections.open} onToggle={sections.toggle} />
        </div>
      </div>
    </Page>
  );
}
