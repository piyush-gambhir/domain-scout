'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlus, ExternalLink, Maximize2, RotateCw, Tag } from 'lucide-react';
import type { DomainEvidence, Offer, RegistryObservation } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { DESTINATION_LABEL, DESTINATION_NOTE, PRICE_KIND, PURCHASE_PATH, confirmationStatus, diagnosticStatus, humanize, nameCheckStatus, registryStatus } from '@/lib/labels';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { qk, useProviders } from '@/lib/queries';
import { useIdempotency } from '@/lib/use-idempotency';
import { isTerminal, useLiveJob } from '@/lib/use-job';
import { cn } from '@/lib/utils';
import { ProviderRequestDialog } from '../actions/provider-request-dialog';
import { ShortlistDialog } from '../actions/shortlist-dialog';
import { useJobStarted } from '../actions/use-job-started';
import { EmptyState, ErrorState, Facts, SectionTitle } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { Skeleton, SkeletonRows } from '../ui/skeleton';
import { CheckedAt, FreshnessText, RelativeTime } from './time';

const tableClass = 'w-full min-w-[34rem] text-left text-sm';
const thClass = 'pb-2 pr-4 text-xs font-medium text-muted-foreground';
const tdClass = 'py-2 pr-4 align-top';

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('mt-8', className)} aria-label={title}>
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  );
}

function ScrollTable({ children }: { children: React.ReactNode }) {
  return <div className="relative -mx-1 overflow-x-auto px-1">{children}</div>;
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[13px]">{children}</span>;
}

function MonoList({ values }: { values: string[] }) {
  if (values.length === 0) return <span className="text-muted-foreground">None returned</span>;
  return (
    <ul className="flex flex-col gap-0.5 font-mono text-[13px]">
      {values.map((value) => (
        <li key={value} className="break-all">
          {value}
        </li>
      ))}
    </ul>
  );
}

function RawDiagnostic({ observationId }: { observationId: string }) {
  const [open, setOpen] = useState(false);
  const raw = useQuery({
    queryKey: ['raw', observationId],
    queryFn: ({ signal }) => api.call('getRawDiagnostic', { params: { id: observationId }, signal }).then((r) => r.data),
    enabled: open,
    staleTime: Infinity,
  });
  return (
    <div className="mt-4">
      <Button size="sm" variant="ghost" className="-ml-3" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide raw response' : 'Show raw response'}
      </Button>
      {open ? (
        raw.isPending ? (
          <Skeleton className="mt-2 h-32" />
        ) : raw.isError ? (
          <ErrorState error={raw.error} className="mt-2" />
        ) : (
          <div className="mt-2">
            <pre className="max-h-96 overflow-auto rounded-md bg-input p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{raw.data.body}</pre>
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

function RegistrySection({ latest }: { latest: RegistryObservation }) {
  const status = registryStatus(latest.outcome);
  const eligibility = latest.eligibility;
  const facts: [React.ReactNode, React.ReactNode][] = [
    ['Checked', <CheckedAt key="c" iso={latest.checkedAt} freshness={latest.freshness} staleAt={latest.staleAt} />],
    ['Checked at', formatDateTime(latest.checkedAt)],
    ['Source', latest.source ? <Mono key="s">{latest.source.registryId}</Mono> : <span className="text-muted-foreground">Not queried</span>],
    ['Protocol', latest.source ? latest.source.protocol.toUpperCase() : 'None'],
    ['Destination', latest.source ? <Mono key="d">{latest.source.destination}</Mono> : 'None'],
    ['Routing', latest.source ? (ROUTING[latest.source.routing] ?? humanize(latest.source.routing)) : 'None'],
    ['Reason', latest.reason.message],
    [
      'Eligibility',
      <span key="e">
        {humanize(eligibility.status)}
        {eligibility.source ? <span className="text-muted-foreground"> · {eligibility.source}</span> : null}
        {eligibility.scope ? <span className="text-muted-foreground"> · {eligibility.scope}</span> : null}
      </span>,
    ],
  ];
  if (latest.matchedName) facts.push(['Matched name', <Mono key="m">{latest.matchedName}</Mono>]);
  if (latest.httpStatus !== null) facts.push(['HTTP status', <Mono key="h">{latest.httpStatus}</Mono>]);
  if (latest.retryAt) facts.push(['Retry after', <RelativeTime key="r" iso={latest.retryAt} />]);
  if (latest.reused) facts.push(['Cache', 'Reused earlier observation']);

  return (
    <Section title="Registry" className="mt-6">
      <StatusLabel status={status} className="mb-4 text-lg font-semibold" />
      <Facts items={facts} />
      {latest.hasRawDiagnostics ? <RawDiagnostic observationId={latest.id} /> : null}
    </Section>
  );
}

function RegistrationSection({ latest }: { latest: RegistryObservation }) {
  const reg = latest.registration;
  if (!reg) return null;
  return (
    <Section title="Registration">
      <Facts
        items={[
          ['Registrar', reg.registrar ?? <span className="text-muted-foreground">Unknown</span>],
          ['Created', formatDate(reg.createdAt)],
          ['Updated', formatDate(reg.updatedAt)],
          ['Registry expiry', formatDate(reg.expiresAt)],
          ['Statuses', <MonoList key="s" values={reg.statuses} />],
          ['Nameservers', <MonoList key="n" values={reg.nameservers} />],
          ['DNSSEC', reg.dnssec === null ? 'Unknown' : reg.dnssec ? 'Signed' : 'Unsigned'],
        ]}
      />
    </Section>
  );
}

function PurchaseSection({ evidence }: { evidence: DomainEvidence }) {
  const providers = [...evidence.providers].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || Number(b.preferred) - Number(a.preferred) || a.name.localeCompare(b.name),
  );
  if (providers.length === 0) return null;
  return (
    <Section title="Providers">
      <ScrollTable>
        <table className={tableClass}>
          <thead>
            <tr>
              <th scope="col" className={thClass}>
                Provider
              </th>
              <th scope="col" className={thClass}>
                Supports .{evidence.suffix}
              </th>
              <th scope="col" className={thClass}>
                Purchase link
              </th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider.providerId} className={cn(!provider.enabled && 'text-muted-foreground')}>
                <td className={tdClass}>
                  <span className="font-medium">{provider.name}</span>
                  {provider.preferred ? <span className="ml-2 text-xs text-muted-foreground">Preferred</span> : null}
                  {!provider.enabled ? <span className="ml-2 text-xs">Disabled</span> : null}
                </td>
                <td className={tdClass}>{provider.supportsSuffix === 'yes' ? 'Yes' : provider.supportsSuffix === 'no' ? 'No' : 'Unknown'}</td>
                <td className={tdClass}>
                  {provider.purchaseUrl ? (
                    <a
                      href={provider.purchaseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                    >
                      {DESTINATION_LABEL[provider.purchaseKind ?? 'search'] ?? 'Open'}
                      <ExternalLink aria-hidden className="size-3.5" />
                      <span className="sr-only"> {provider.name} (opens in a new tab)</span>
                    </a>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                  {provider.purchaseKind && DESTINATION_NOTE[provider.purchaseKind] ? (
                    <span className="ml-2 text-xs text-muted-foreground">{DESTINATION_NOTE[provider.purchaseKind]}</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollTable>
    </Section>
  );
}

function money(amount: string | null, currency: string) {
  return amount === null ? <span className="text-muted-foreground">Unknown</span> : <Mono>{formatMoney(amount, currency)}</Mono>;
}

function OfferFees({ offer }: { offer: Offer }) {
  const parts: React.ReactNode[] = [];
  if (offer.fees.icann !== null) parts.push(<span key="icann">ICANN {formatMoney(offer.fees.icann, offer.currency)}</span>);
  for (const fee of offer.fees.other) {
    parts.push(
      <span key={fee.label}>
        {fee.label} {fee.amount === null ? 'Unknown' : formatMoney(fee.amount, offer.currency)}
      </span>,
    );
  }
  parts.push(<span key="tax">Tax {offer.fees.tax === 'unknown' ? 'unknown' : offer.fees.tax}</span>);
  return <span className="flex flex-col text-xs">{parts}</span>;
}

function OffersSection({ offers, names }: { offers: Offer[]; names: Map<string, string> }) {
  if (offers.length === 0) return null;
  const sorted = [...offers].sort((a, b) => a.providerId.localeCompare(b.providerId) || a.purchasePath.localeCompare(b.purchasePath));
  return (
    <Section title="Prices">
      <ScrollTable>
        <table className={cn(tableClass, 'min-w-[52rem]')}>
          <thead>
            <tr>
              {['Provider', 'Kind', 'Path', 'Registration', 'Renewal', 'Term', 'Fees', 'Premium', 'Observed', ''].map((h, i) => (
                <th key={i} scope="col" className={thClass}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((offer) => (
              <tr key={offer.id}>
                <td className={tdClass}>
                  <span className="font-medium">{names.get(offer.providerId) ?? offer.providerId}</span>
                  {offer.region ? <span className="block text-xs text-muted-foreground">{offer.region}</span> : null}
                </td>
                <td className={tdClass}>{PRICE_KIND[offer.kind]}</td>
                <td className={tdClass}>{PURCHASE_PATH[offer.purchasePath]}</td>
                <td className={tdClass}>
                  {offer.purchasePath === 'transfer' ? money(offer.transfer.amount, offer.currency) : money(offer.registration.amount, offer.currency)}
                  {offer.promotion ? (
                    <span className="block max-w-48 text-xs text-muted-foreground">
                      Promotion: {offer.promotion.description}
                      {offer.promotion.requiresTermYears ? `, ${offer.promotion.requiresTermYears} yr term` : ''}
                      {offer.promotion.eligibilityVerified ? '' : ', eligibility unverified'}
                      {offer.promotion.expiresAt ? `, ends ${formatDate(offer.promotion.expiresAt)}` : ''}
                    </span>
                  ) : null}
                </td>
                <td className={tdClass}>{money(offer.renewal.amount, offer.currency)}</td>
                <td className={tdClass}>
                  {offer.registration.years} yr
                  {offer.minYears && offer.minYears > 1 ? <span className="block text-xs text-muted-foreground">min {offer.minYears} yr</span> : null}
                </td>
                <td className={tdClass}>
                  <OfferFees offer={offer} />
                </td>
                <td className={tdClass}>
                  {offer.premium.status === 'confirmed'
                    ? 'Premium'
                    : offer.premium.status === 'not_premium'
                      ? 'Standard'
                      : offer.premium.status === 'hint'
                        ? 'Possible premium'
                        : 'Unknown'}
                </td>
                <td className={tdClass}>
                  <CheckedAt iso={offer.observedAt} freshness={offer.freshness} staleAt={offer.staleAt} expiresAt={offer.quoteExpiresAt} />
                  <span className="block text-xs text-muted-foreground">{offer.source.label}</span>
                </td>
                <td className={tdClass}>
                  {offer.destination ? (
                    <a href={offer.destination.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
                      {DESTINATION_LABEL[offer.destination.kind] ?? 'Open'}
                      <ExternalLink aria-hidden className="size-3.5" />
                      <span className="sr-only"> {names.get(offer.providerId) ?? offer.providerId} (opens in a new tab)</span>
                    </a>
                  ) : null}
                  {offer.destination && DESTINATION_NOTE[offer.destination.kind] ? (
                    <span className="block text-xs text-muted-foreground">{DESTINATION_NOTE[offer.destination.kind]}</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollTable>
    </Section>
  );
}

function ConfirmationsSection({ evidence, names }: { evidence: DomainEvidence; names: Map<string, string> }) {
  if (evidence.confirmations.length === 0) return null;
  return (
    <Section title="Provider confirmations">
      <ScrollTable>
        <table className={tableClass}>
          <thead>
            <tr>
              {['Provider', 'Status', 'Premium', 'Checked', 'Destination'].map((h) => (
                <th key={h} scope="col" className={thClass}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {evidence.confirmations.map((c) => (
              <tr key={c.id}>
                <td className={tdClass}>{names.get(c.providerId) ?? c.providerId}</td>
                <td className={tdClass}>
                  <StatusLabel status={confirmationStatus(c.status)} />
                  <span className="block text-xs text-muted-foreground">{c.reason.message}</span>
                </td>
                <td className={tdClass}>{c.premium === null ? 'Unknown' : c.premium ? 'Premium' : 'Standard'}</td>
                <td className={tdClass}>
                  <CheckedAt iso={c.checkedAt} freshness={c.freshness} staleAt={c.staleAt} />
                </td>
                <td className={tdClass}>
                  <Mono>{c.destination}</Mono>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollTable>
    </Section>
  );
}

function ListingsSection({ evidence }: { evidence: DomainEvidence }) {
  if (evidence.listings.length === 0) return null;
  return (
    <Section title="Aftermarket listings">
      <ul className="flex flex-col gap-4">
        {evidence.listings.map((listing) => (
          <li key={listing.id} className="text-sm">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="font-medium">{listing.marketplace}</span>
              <span>{humanize(listing.status)}</span>
              {listing.price ? <Mono>{formatMoney(listing.price.amount, listing.price.currency)}</Mono> : <span className="text-muted-foreground">Price unknown</span>}
              <span className="text-muted-foreground">
                <RelativeTime iso={listing.observedAt} /> <FreshnessText freshness={listing.freshness} hideFresh />
              </span>
              {listing.url ? (
                <a href={listing.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
                  Listing
                  <ExternalLink aria-hidden className="size-3.5" />
                </a>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{listing.caveat}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function NameChecksSection({ evidence }: { evidence: DomainEvidence }) {
  if (evidence.nameChecks.length === 0) return null;
  return (
    <Section title="Name checks">
      <ScrollTable>
        <table className={tableClass}>
          <thead>
            <tr>
              {['Name', 'Service', 'Result', 'Checked', 'Destination'].map((h) => (
                <th key={h} scope="col" className={thClass}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {evidence.nameChecks.map((check) => (
              <tr key={check.id}>
                <td className={tdClass}>
                  <Mono>{check.name}</Mono>
                </td>
                <td className={tdClass}>
                  {humanize(check.service)}
                  <span className="block text-xs text-muted-foreground">{check.namespace}</span>
                </td>
                <td className={tdClass}>
                  <StatusLabel status={nameCheckStatus(check.outcome)} />
                </td>
                <td className={tdClass}>
                  <RelativeTime iso={check.checkedAt} />
                </td>
                <td className={tdClass}>{check.destination ? <Mono>{check.destination}</Mono> : 'None'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollTable>
    </Section>
  );
}

function DiagnosticsSection({ evidence }: { evidence: DomainEvidence }) {
  if (evidence.diagnostics.length === 0) return null;
  return (
    <Section title="Diagnostics">
      <ul className="flex flex-col gap-4">
        {evidence.diagnostics.map((diagnostic) => (
          <li key={diagnostic.id} className="text-sm">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium">{humanize(diagnostic.check)}</span>
              <StatusLabel status={diagnosticStatus(diagnostic.outcome)} />
              <Mono>{diagnostic.destination}</Mono>
              <RelativeTime iso={diagnostic.checkedAt} className="text-muted-foreground" />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{diagnostic.reason.message}</p>
            {Object.keys(diagnostic.data).length > 0 ? (
              <details className="mt-1">
                <summary className="w-fit cursor-pointer rounded-sm text-xs text-muted-foreground hover:text-foreground">Observed data</summary>
                <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-input p-3 font-mono text-xs whitespace-pre-wrap break-all">
                  {JSON.stringify(diagnostic.data, null, 2)}
                </pre>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">Diagnostics never change the registry result.</p>
    </Section>
  );
}

function HistorySection({ older }: { older: RegistryObservation[] }) {
  if (older.length === 0) return null;
  return (
    <Section title="Earlier registry evidence">
      <ul className="flex flex-col gap-2 text-sm">
        {older.map((observation) => (
          <li key={observation.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <StatusLabel status={registryStatus(observation.outcome)} className="w-32" />
            <span className="text-muted-foreground" title={formatDateTime(observation.checkedAt)}>
              {formatDateTime(observation.checkedAt)}
            </span>
            <Mono>{observation.source ? `${observation.source.protocol.toUpperCase()} ${observation.source.registryId}` : 'Not queried'}</Mono>
            <span className="w-full text-xs text-muted-foreground">{observation.reason.message}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Registry evidence, registration facts, providers, prices and optional checks for one domain. */
export function DomainDetail({ name, variant }: { name: string; variant: 'panel' | 'page' }) {
  const client = useQueryClient();
  const providers = useProviders();
  const started = useJobStarted();
  const idempotency = useIdempotency();
  const [recheckJobId, setRecheckJobId] = useState<string | null>(null);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [shortlistOpen, setShortlistOpen] = useState(false);

  const evidence = useQuery({
    queryKey: qk.evidence(name),
    queryFn: ({ signal }) => api.call('getDomainEvidence', { params: { name }, signal }).then((r) => r.data),
  });

  // Follow the recheck job; refresh the evidence when it finishes.
  const recheckJob = useLiveJob(recheckJobId);
  const recheckDone = isTerminal(recheckJob.data);
  useEffect(() => {
    if (recheckJobId && recheckDone) void client.invalidateQueries({ queryKey: qk.evidence(name) });
  }, [client, name, recheckJobId, recheckDone]);

  const recheck = useMutation({
    mutationFn: async () => {
      const body = { domains: [name] };
      return (await api.call('createRecheck', { body, idempotencyKey: idempotency.keyFor(body) })).data;
    },
    onSuccess: (job) => {
      idempotency.reset();
      setRecheckJobId(job.id);
      started(job, 'Recheck started');
    },
  });

  const names = new Map<string, string>();
  for (const p of providers.data ?? []) names.set(p.id, p.name);
  for (const p of evidence.data?.providers ?? []) names.set(p.providerId, p.name);

  const target = { count: 1, resolveDomains: async () => [name] };
  const rechecking = recheck.isPending || Boolean(recheckJobId && !recheckDone && recheckJob.data);

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" disabled={rechecking} onClick={() => recheck.mutate()}>
        <RotateCw className={cn(rechecking && 'motion-safe:animate-spin')} />
        {rechecking ? 'Rechecking' : 'Recheck'}
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setQuoteOpen(true)}>
        <Tag />
        Quote
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setShortlistOpen(true)}>
        <BookmarkPlus />
        Shortlist
      </Button>
      {variant === 'panel' ? (
        <Button size="sm" variant="quiet" asChild>
          <Link href={`/domains/${encodeURIComponent(name)}`}>
            <Maximize2 />
            Full page
          </Link>
        </Button>
      ) : null}
    </div>
  );

  let body: React.ReactNode;
  if (evidence.isPending) {
    body = (
      <div className="mt-6 flex flex-col gap-4">
        <Skeleton className="h-7 w-40" />
        <SkeletonRows rows={6} />
      </div>
    );
  } else if (evidence.isError) {
    body = <ErrorState error={evidence.error} onRetry={() => evidence.refetch()} className="mt-6" />;
  } else {
    const data = evidence.data;
    const [latest, ...older] = data.registry;
    body = (
      <>
        {latest ? (
          <>
            <RegistrySection latest={latest} />
            <RegistrationSection latest={latest} />
          </>
        ) : (
          <EmptyState className="py-8 text-left">No registry evidence yet.</EmptyState>
        )}
        <PurchaseSection evidence={data} />
        <OffersSection offers={data.offers} names={names} />
        <ConfirmationsSection evidence={data} names={names} />
        <ListingsSection evidence={data} />
        <NameChecksSection evidence={data} />
        <DiagnosticsSection evidence={data} />
        <HistorySection older={older} />
        {data.collections.length > 0 ? (
          <Section title="Shortlists">
            <ul className="flex flex-col gap-1 text-sm">
              {data.collections.map((collection) => (
                <li key={collection.id}>
                  <Link href={`/collections/${collection.id}`} className="underline-offset-4 hover:underline">
                    {collection.name}
                  </Link>
                  {collection.notes ? <span className="ml-2 text-muted-foreground">{collection.notes}</span> : null}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </>
    );
  }

  const unicode = evidence.data?.unicode;
  return (
    <div>
      {variant === 'page' ? (
        <header className="mb-2 flex flex-col gap-1">
          <h1 className="break-all font-mono text-xl font-semibold tracking-tight">{unicode && unicode !== name ? unicode : name}</h1>
          {unicode && unicode !== name ? <p className="font-mono text-sm text-muted-foreground">{name}</p> : null}
        </header>
      ) : unicode && unicode !== name ? (
        <p className="-mt-1 mb-2 font-mono text-sm text-muted-foreground">{unicode}</p>
      ) : null}
      <div className={cn(variant === 'page' ? 'mt-4' : 'mt-2')}>{actions}</div>
      {body}
      <ProviderRequestDialog open={quoteOpen} onOpenChange={setQuoteOpen} target={target} />
      <ShortlistDialog open={shortlistOpen} onOpenChange={setShortlistOpen} target={target} />
    </div>
  );
}
