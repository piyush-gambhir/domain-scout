'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlus, ChevronRight, ExternalLink, Maximize2, RotateCw, Search, Tag } from 'lucide-react';
import type { DomainEvidence, Offer, RegistryObservation } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import {
  DESTINATION_LABEL,
  DESTINATION_NOTE,
  PRICE_KIND,
  PURCHASE_PATH,
  confirmationStatus,
  diagnosticStatus,
  humanize,
  nameCheckStatus,
  registryStatus,
} from '@/lib/labels';
import { formatDate, formatDateTime, formatMoney, plural } from '@/lib/format';
import { lowestRegistrationOffer } from '@/lib/money';
import { qk, useProviders } from '@/lib/queries';
import { useIdempotency } from '@/lib/use-idempotency';
import { isTerminal, useLiveJob } from '@/lib/use-job';
import { cn } from '@/lib/utils';
import { BackButton } from '../back-button';
import { ProviderRequestDialog } from '../actions/provider-request-dialog';
import { ShortlistDialog } from '../actions/shortlist-dialog';
import { useJobStarted } from '../actions/use-job-started';
import { EmptyState, ErrorState, Facts, Page, PageHeader, ScrollPane, SectionTitle } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { Dock } from '../ui/dock';
import { Input } from '../ui/input';
import { Skeleton, SkeletonRows } from '../ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { CheckedAt, FreshnessText, RelativeTime } from './time';

export type DomainTab = 'overview' | 'providers' | 'prices' | 'evidence' | 'checks';

const thClass = 'pb-1.5 pr-3 text-left text-xs font-medium text-muted-foreground';
const tdClass = 'py-1.5 pr-3 align-top';

function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[13px]', className)}>{children}</span>;
}

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0', className)} aria-label={title}>
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  );
}

function OutLink({ href, label, name }: { href: string; label: string; name: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm underline-offset-4 hover:underline">
      {label}
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only"> {name} (opens in a new tab)</span>
    </a>
  );
}

/** Evidence, provider names and kinds for one domain. */
function useDomainEvidence(name: string) {
  const providers = useProviders();
  const evidence = useQuery({
    queryKey: qk.evidence(name),
    queryFn: ({ signal }) => api.call('getDomainEvidence', { params: { name }, signal }).then((r) => r.data),
  });
  const { names, kinds } = useMemo(() => {
    const names = new Map<string, string>();
    const kinds = new Map<string, 'registrar' | 'directory'>();
    for (const p of providers.data ?? []) {
      names.set(p.id, p.name);
      kinds.set(p.id, p.kind);
    }
    for (const p of evidence.data?.providers ?? []) names.set(p.providerId, p.name);
    return { names, kinds };
  }, [providers.data, evidence.data]);
  return { evidence, providersReady: !providers.isPending, names, kinds };
}

/** Recheck, quote and shortlist for one domain. A recheck refreshes the evidence when it finishes. */
export function DomainActions({ name }: { name: string }) {
  const client = useQueryClient();
  const started = useJobStarted();
  const idempotency = useIdempotency();
  const [recheckJobId, setRecheckJobId] = useState<string | null>(null);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [shortlistOpen, setShortlistOpen] = useState(false);
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
  const rechecking = recheck.isPending || Boolean(recheckJobId && !recheckDone && recheckJob.data);
  const target = { count: 1, resolveDomains: async () => [name] };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
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
      <ProviderRequestDialog open={quoteOpen} onOpenChange={setQuoteOpen} target={target} />
      <ShortlistDialog open={shortlistOpen} onOpenChange={setShortlistOpen} target={target} />
    </div>
  );
}

/* Overview */

const ROUTING: Record<string, string> = { iana_bootstrap: 'IANA bootstrap', curated: 'Curated' };

function RegistrySummary({ latest }: { latest: RegistryObservation | undefined }) {
  if (!latest) {
    return (
      <Section title="Registry">
        <p className="text-sm text-muted-foreground">No registry evidence yet.</p>
      </Section>
    );
  }
  const eligibility = latest.eligibility;
  const facts: [React.ReactNode, React.ReactNode][] = [
    ['Checked', <CheckedAt key="c" iso={latest.checkedAt} freshness={latest.freshness} staleAt={latest.staleAt} />],
    [
      'Source',
      latest.source ? (
        <span key="s">
          <Mono>{latest.source.registryId}</Mono> <span className="text-muted-foreground">{latest.source.protocol.toUpperCase()}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">Not queried</span>
      ),
    ],
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
  if (latest.retryAt) facts.push(['Retry after', <RelativeTime key="r" iso={latest.retryAt} />]);
  return (
    <Section title="Registry">
      <StatusLabel status={registryStatus(latest.outcome)} className="mb-2 text-base font-semibold" />
      <Facts items={facts} />
    </Section>
  );
}

function ConfirmationSummary({ evidence, names, onTab }: { evidence: DomainEvidence; names: Map<string, string>; onTab?: (tab: DomainTab) => void }) {
  const newest = [...evidence.confirmations].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
  if (!newest) return null;
  return (
    <Section title="Provider confirmation">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <StatusLabel status={confirmationStatus(newest.status)} className="font-medium" />
        <span>{names.get(newest.providerId) ?? newest.providerId}</span>
        <span className="text-muted-foreground">
          <CheckedAt iso={newest.checkedAt} freshness={newest.freshness} staleAt={newest.staleAt} />
        </span>
        {evidence.confirmations.length > 1 && onTab ? (
          <Button size="sm" variant="link" className="text-muted-foreground" onClick={() => onTab('evidence')}>
            All {evidence.confirmations.length}
          </Button>
        ) : null}
      </p>
    </Section>
  );
}

function BestPrice({ offers, names, onTab }: { offers: Offer[]; names: Map<string, string>; onTab?: (tab: DomainTab) => void }) {
  const best = lowestRegistrationOffer(offers);
  return (
    <Section title="Best known price">
      {best ? (
        <div className="flex flex-col gap-1 text-sm">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-base font-semibold tabular">{formatMoney(best.registration.amount, best.currency)}</span>
            <span>
              {PRICE_KIND[best.kind]} at {names.get(best.providerId) ?? best.providerId}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            New registration for {best.registration.years} yr
            {best.renewal.amount !== null ? ` · renews ${formatMoney(best.renewal.amount, best.currency)} for ${best.renewal.years} yr` : ' · renewal unknown'}
            {' · '}
            <CheckedAt iso={best.observedAt} freshness={best.freshness} staleAt={best.staleAt} expiresAt={best.quoteExpiresAt} />
            {' · '}
            {best.source.label}
          </p>
          {best.promotion ? <PromotionTerms promotion={best.promotion} /> : null}
        </div>
      ) : (
        <p className="text-sm">
          Unknown <span className="text-muted-foreground">· no retained registration price</span>
        </p>
      )}
      {offers.length > 0 && onTab ? (
        <Button size="sm" variant="link" className="mt-1 text-muted-foreground" onClick={() => onTab('prices')}>
          All {plural(offers.length, 'price')}
        </Button>
      ) : null}
    </Section>
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

function RegistrationFacts({ latest }: { latest: RegistryObservation | undefined }) {
  const reg = latest?.registration;
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

function Shortlists({ evidence }: { evidence: DomainEvidence }) {
  if (evidence.collections.length === 0) return null;
  return (
    <Section title="Shortlists">
      <ul className="flex flex-col gap-1 text-sm">
        {evidence.collections.map((collection) => (
          <li key={collection.id} className="min-w-0 truncate">
            <Link href={`/collections/${collection.id}`} className="rounded-sm underline-offset-4 hover:underline">
              {collection.name}
            </Link>
            {collection.notes ? <span className="ml-2 text-muted-foreground">{collection.notes}</span> : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Registry outcome, freshness, the newest provider confirmation, best price and registration facts. */
function Overview({ evidence, names, onTab }: { evidence: DomainEvidence; names: Map<string, string>; onTab?: (tab: DomainTab) => void }) {
  const latest = evidence.registry[0];
  return (
    <div className="flex flex-col gap-5">
      <RegistrySummary latest={latest} />
      <ConfirmationSummary evidence={evidence} names={names} onTab={onTab} />
      <BestPrice offers={evidence.offers} names={names} onTab={onTab} />
      <RegistrationFacts latest={latest} />
      <Shortlists evidence={evidence} />
    </div>
  );
}

/* Providers */

function supportLabel(value: 'yes' | 'no' | 'unknown') {
  return value === 'yes' ? 'Yes' : value === 'no' ? 'No' : 'Unknown';
}

type SuffixProvider = DomainEvidence['providers'][number];

function PurchaseLink({ provider }: { provider: SuffixProvider }) {
  return (
    <>
      {provider.purchaseUrl ? (
        <OutLink href={provider.purchaseUrl} label={DESTINATION_LABEL[provider.purchaseKind ?? 'search'] ?? 'Open'} name={provider.name} />
      ) : (
        <span className="text-muted-foreground">None</span>
      )}
      {provider.purchaseKind && DESTINATION_NOTE[provider.purchaseKind] ? (
        <span className="block text-xs text-muted-foreground">{DESTINATION_NOTE[provider.purchaseKind]}</span>
      ) : null}
    </>
  );
}

/** The registry-published registrar list for this suffix, collapsed to one row until opened. */
function DirectoryGroup({ entries, suffix }: { entries: SuffixProvider[]; suffix: string }) {
  // Open, it takes the rest of the pane's height and its list scrolls inside it.
  const id = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const shown = query ? entries.filter((e) => e.name.toLowerCase().includes(query)) : entries;
  const kinds = new Set(entries.map((e) => e.purchaseKind));
  const commonNote = kinds.size === 1 ? DESTINATION_NOTE[[...kinds][0] ?? ''] : undefined;
  return (
    <section aria-label="Registry directory" className={cn('flex min-w-0 shrink-0 flex-col', open && 'min-h-56 flex-1')}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        onClick={() => setOpen((v) => !v)}
        className="focus-inset flex h-row w-full items-center gap-2 rounded-md bg-input/60 px-2 text-left text-sm transition-colors hover:bg-input"
      >
        <ChevronRight aria-hidden className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 truncate font-medium">
          {plural(entries.length, 'registrar')} from the .{suffix} registry
        </span>
        {commonNote ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">Websites, {commonNote.toLowerCase()}</span> : null}
      </button>
      {open ? (
        <div id={`${id}-list`} className="mt-2 flex min-h-0 flex-1 flex-col gap-2">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" aria-label="Search registrars" placeholder="Search registrars" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          {shown.length === 0 ? (
            <p className="py-3 text-center text-sm text-muted-foreground">No registrar matches.</p>
          ) : (
            <ul aria-label={`Registrars for .${suffix}`} className="relative -mx-1 min-h-0 flex-1 overflow-y-auto px-1 max-lg:max-h-80">
              {shown.map((entry) => (
                <li key={entry.providerId} className="flex min-h-8 items-center justify-between gap-3 rounded-md px-2 text-sm hover:bg-hover">
                  <span className={cn('min-w-0 truncate', !entry.enabled && 'text-muted-foreground')}>{entry.name}</span>
                  <span className="shrink-0">
                    {entry.purchaseUrl ? (
                      <OutLink href={entry.purchaseUrl} label={DESTINATION_LABEL[entry.purchaseKind ?? 'website'] ?? 'Open'} name={entry.name} />
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function Confirmations({ evidence, names }: { evidence: DomainEvidence; names: Map<string, string> }) {
  if (evidence.confirmations.length === 0) return null;
  return (
    <Section title="Provider confirmations">
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr>
            <th scope="col" className={cn(thClass, 'w-[40%]')}>
              Provider
            </th>
            <th scope="col" className={thClass}>
              Status
            </th>
            <th scope="col" className={cn(thClass, 'w-28')}>
              Checked
            </th>
          </tr>
        </thead>
        <tbody>
          {evidence.confirmations.map((c) => (
            <tr key={c.id}>
              <td className={tdClass}>
                <span className="block truncate">{names.get(c.providerId) ?? c.providerId}</span>
                <Mono className="block truncate text-xs text-muted-foreground">{c.destination}</Mono>
              </td>
              <td className={tdClass}>
                <StatusLabel status={confirmationStatus(c.status)} />
                <span className="block text-xs text-muted-foreground">
                  {c.reason.message}
                  {c.premium === null ? '' : c.premium ? ' · Premium' : ' · Standard'}
                </span>
              </td>
              <td className={tdClass}>
                <CheckedAt iso={c.checkedAt} freshness={c.freshness} staleAt={c.staleAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/** Named registrars first; the registry-published directory collapses into one expandable row. */
function ProvidersTab({ evidence, kinds, ready }: { evidence: DomainEvidence; kinds: Map<string, string>; ready: boolean }) {
  if (!ready) return <SkeletonRows rows={6} />;
  const named = evidence.providers
    .filter((p) => kinds.get(p.providerId) !== 'directory')
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(b.preferred) - Number(a.preferred) || a.name.localeCompare(b.name));
  const directory = evidence.providers.filter((p) => kinds.get(p.providerId) === 'directory').sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <section aria-label="Providers" className="min-w-0 shrink-0">
        {named.length === 0 ? (
          <p className="text-sm text-muted-foreground">No named providers for .{evidence.suffix}.</p>
        ) : (
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Provider
                </th>
                <th scope="col" className={cn(thClass, 'w-24')}>
                  Supports .{evidence.suffix}
                </th>
                <th scope="col" className={cn(thClass, 'w-36')}>
                  Purchase link
                </th>
              </tr>
            </thead>
            <tbody>
              {named.map((provider) => (
                <tr key={provider.providerId} className={cn(!provider.enabled && 'text-muted-foreground')}>
                  <td className={tdClass}>
                    <span className="font-medium">{provider.name}</span>
                    {provider.preferred ? <span className="ml-2 text-xs text-muted-foreground">Preferred</span> : null}
                    {!provider.enabled ? <span className="ml-2 text-xs">Disabled</span> : null}
                  </td>
                  <td className={tdClass}>{supportLabel(provider.supportsSuffix)}</td>
                  <td className={tdClass}>
                    <PurchaseLink provider={provider} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {directory.length > 0 ? <DirectoryGroup entries={directory} suffix={evidence.suffix} /> : null}
    </div>
  );
}

/* Prices */

function money(amount: string | null, currency: string) {
  return amount === null ? <span className="text-muted-foreground">Unknown</span> : <Mono className="tabular">{formatMoney(amount, currency)}</Mono>;
}

/** Muted line under an amount: the years it covers, or other terms that change its meaning. */
function Terms({ children }: { children: React.ReactNode }) {
  return <span className="block text-xs text-muted-foreground">{children}</span>;
}

function transferYears(includes: number | null): string {
  if (includes === null) return 'Included years unknown';
  return includes === 0 ? 'No registration year included' : `Includes ${includes} yr`;
}

/** Promotion conditions as supplied; an unverified eligibility is always called out. */
function PromotionTerms({ promotion }: { promotion: NonNullable<Offer['promotion']> }) {
  return (
    <span className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground" data-testid="promotion">
      <span className="text-foreground">Promotion: {promotion.description}</span>
      {promotion.requiresTermYears ? <span>Requires {promotion.requiresTermYears} yr term</span> : null}
      {promotion.restrictions ? <span>Restrictions: {promotion.restrictions}</span> : null}
      {promotion.expiresAt ? <span>Ends {formatDate(promotion.expiresAt)}</span> : null}
      {promotion.eligibilityVerified ? null : <StatusLabel status={{ label: 'Eligibility not verified', tone: 'caution', unresolved: true }} />}
    </span>
  );
}

function feeText(offer: Offer): string {
  const parts: string[] = [];
  if (offer.fees.icann !== null) parts.push(`ICANN ${formatMoney(offer.fees.icann, offer.currency)}`);
  for (const fee of offer.fees.other) parts.push(`${fee.label} ${fee.amount === null ? 'unknown' : formatMoney(fee.amount, offer.currency)}`);
  parts.push(`Tax ${offer.fees.tax === 'unknown' ? 'unknown' : offer.fees.tax}`);
  return parts.join(' · ');
}

function premiumText(offer: Offer): string {
  const status = offer.premium.status;
  return status === 'confirmed' ? 'Premium' : status === 'not_premium' ? 'Standard' : status === 'hint' ? 'Possible premium' : 'Premium unknown';
}

function PricesTab({ offers, names }: { offers: Offer[]; names: Map<string, string> }) {
  if (offers.length === 0) return <EmptyState>No retained prices.</EmptyState>;
  const sorted = [...offers].sort((a, b) => a.providerId.localeCompare(b.providerId) || a.purchasePath.localeCompare(b.purchasePath));
  return (
    <section aria-label="Prices" className="min-w-0">
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr>
            <th scope="col" className={cn(thClass, 'w-[30%]')}>
              Provider
            </th>
            <th scope="col" className={thClass}>
              Registration
            </th>
            <th scope="col" className={thClass}>
              Renewal
            </th>
            <th scope="col" className={cn(thClass, 'w-[32%]')}>
              Details
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((offer) => {
            const name = names.get(offer.providerId) ?? offer.providerId;
            return (
              <tr key={offer.id}>
                <td className={tdClass}>
                  <span className="block truncate font-medium">{name}</span>
                  <Terms>
                    {PRICE_KIND[offer.kind]} · {PURCHASE_PATH[offer.purchasePath]}
                    {offer.region ? ` · ${offer.region}` : ''}
                  </Terms>
                </td>
                <td className={tdClass} data-testid="offer-registration">
                  {offer.purchasePath === 'transfer' ? (
                    <>
                      {money(offer.transfer.amount, offer.currency)}
                      <Terms>{transferYears(offer.transfer.includesYears)}</Terms>
                    </>
                  ) : (
                    <>
                      {money(offer.registration.amount, offer.currency)}
                      <Terms>
                        for {offer.registration.years} yr{offer.minYears && offer.minYears > 1 ? `, minimum ${offer.minYears} yr` : ''}
                      </Terms>
                    </>
                  )}
                  {offer.promotion ? <PromotionTerms promotion={offer.promotion} /> : null}
                </td>
                <td className={tdClass} data-testid="offer-renewal">
                  {money(offer.renewal.amount, offer.currency)}
                  {offer.renewal.amount !== null ? <Terms>for {offer.renewal.years} yr</Terms> : null}
                </td>
                <td className={cn(tdClass, 'text-xs')}>
                  <span className="block text-muted-foreground">{feeText(offer)}</span>
                  <span className="block text-muted-foreground">{premiumText(offer)}</span>
                  <span className="block">
                    <CheckedAt iso={offer.observedAt} freshness={offer.freshness} staleAt={offer.staleAt} expiresAt={offer.quoteExpiresAt} />
                    <span className="text-muted-foreground"> · {offer.source.label}</span>
                  </span>
                  {offer.destination ? (
                    <span className="block">
                      <OutLink href={offer.destination.url} label={DESTINATION_LABEL[offer.destination.kind] ?? 'Open'} name={name} />
                      {DESTINATION_NOTE[offer.destination.kind] ? <span className="text-muted-foreground"> · {DESTINATION_NOTE[offer.destination.kind]}</span> : null}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/* Evidence */

function RawDiagnostic({ observationId }: { observationId: string }) {
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
            <pre className="max-h-80 overflow-auto rounded-md bg-input p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{raw.data.body}</pre>
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

/** Technical registry evidence, provider confirmations and earlier registry observations. */
function EvidenceTab({ evidence, names }: { evidence: DomainEvidence; names: Map<string, string> }) {
  const [latest, ...older] = evidence.registry;
  if (!latest && evidence.confirmations.length === 0) return <EmptyState>No registry evidence yet.</EmptyState>;
  if (!latest) return <Confirmations evidence={evidence} names={names} />;
  const facts: [React.ReactNode, React.ReactNode][] = [
    ['Outcome', <StatusLabel key="o" status={registryStatus(latest.outcome)} />],
    ['Checked at', formatDateTime(latest.checkedAt)],
    ['Protocol', latest.source ? latest.source.protocol.toUpperCase() : 'None'],
    ['Destination', latest.source ? <Mono key="d" className="break-all">{latest.source.destination}</Mono> : 'None'],
    ['Routing', latest.source ? (ROUTING[latest.source.routing] ?? humanize(latest.source.routing)) : 'None'],
  ];
  if (latest.matchedName) facts.push(['Matched name', <Mono key="m">{latest.matchedName}</Mono>]);
  if (latest.httpStatus !== null) facts.push(['HTTP status', <Mono key="h">{latest.httpStatus}</Mono>]);
  if (latest.reused) facts.push(['Cache', 'Reused earlier observation']);
  return (
    <div className="flex flex-col gap-5">
      <Section title="Latest registry evidence">
        <Facts items={facts} />
        {latest.hasRawDiagnostics ? <RawDiagnostic observationId={latest.id} /> : null}
      </Section>
      <Confirmations evidence={evidence} names={names} />
      <Section title="Earlier registry evidence">
        {older.length === 0 ? (
          <p className="text-sm text-muted-foreground">None retained.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {older.map((observation) => (
              <li key={observation.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <StatusLabel status={registryStatus(observation.outcome)} className="w-28" />
                <span className="text-muted-foreground">{formatDateTime(observation.checkedAt)}</span>
                <Mono>{observation.source ? `${observation.source.protocol.toUpperCase()} ${observation.source.registryId}` : 'Not queried'}</Mono>
                <span className="w-full text-xs text-muted-foreground">{observation.reason.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/* Checks */

function hasChecks(evidence: DomainEvidence) {
  return evidence.nameChecks.length > 0 || evidence.diagnostics.length > 0 || evidence.listings.length > 0;
}

function ChecksTab({ evidence }: { evidence: DomainEvidence }) {
  return (
    <div className="flex flex-col gap-5">
      {evidence.nameChecks.length > 0 ? (
        <Section title="Name checks">
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Name
                </th>
                <th scope="col" className={thClass}>
                  Result
                </th>
                <th scope="col" className={cn(thClass, 'w-24')}>
                  Checked
                </th>
              </tr>
            </thead>
            <tbody>
              {evidence.nameChecks.map((check) => (
                <tr key={check.id}>
                  <td className={tdClass}>
                    <Mono className="block truncate">{check.name}</Mono>
                    <span className="block truncate text-xs text-muted-foreground">
                      {humanize(check.service)} · {check.namespace}
                    </span>
                  </td>
                  <td className={tdClass}>
                    <StatusLabel status={nameCheckStatus(check.outcome)} />
                    <Mono className="block truncate text-xs text-muted-foreground">{check.destination ?? 'No destination'}</Mono>
                  </td>
                  <td className={tdClass}>
                    <RelativeTime iso={check.checkedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}
      {evidence.diagnostics.length > 0 ? (
        <Section title="Diagnostics">
          <ul className="flex flex-col gap-3">
            {evidence.diagnostics.map((diagnostic) => (
              <li key={diagnostic.id} className="text-sm">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium">{humanize(diagnostic.check)}</span>
                  <StatusLabel status={diagnosticStatus(diagnostic.outcome)} />
                  <Mono>{diagnostic.destination}</Mono>
                  <RelativeTime iso={diagnostic.checkedAt} className="text-muted-foreground" />
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{diagnostic.reason.message}</p>
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
          <p className="mt-2 text-xs text-muted-foreground">Diagnostics never change the registry result.</p>
        </Section>
      ) : null}
      {evidence.listings.length > 0 ? (
        <Section title="Aftermarket listings">
          <ul className="flex flex-col gap-3">
            {evidence.listings.map((listing) => (
              <li key={listing.id} className="text-sm">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-medium">{listing.marketplace}</span>
                  <span>{humanize(listing.status)}</span>
                  {listing.price ? <Mono>{formatMoney(listing.price.amount, listing.price.currency)}</Mono> : <span className="text-muted-foreground">Price unknown</span>}
                  <span className="text-muted-foreground">
                    <RelativeTime iso={listing.observedAt} /> <FreshnessText freshness={listing.freshness} hideFresh />
                  </span>
                  {listing.url ? <OutLink href={listing.url} label="Listing" name={listing.marketplace} /> : null}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{listing.caveat}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

/* Composition */

const TAB_LABEL: Record<DomainTab, string> = { overview: 'Overview', providers: 'Providers', prices: 'Prices', evidence: 'Evidence', checks: 'Checks' };

function tabsFor(evidence: DomainEvidence | undefined, withOverview: boolean): DomainTab[] {
  const tabs: DomainTab[] = withOverview ? ['overview', 'providers', 'prices', 'evidence'] : ['providers', 'prices', 'evidence'];
  if (evidence && hasChecks(evidence)) tabs.push('checks');
  return tabs;
}

function TabBody({
  tab,
  evidence,
  names,
  kinds,
  ready,
  onTab,
}: {
  tab: DomainTab;
  evidence: DomainEvidence;
  names: Map<string, string>;
  kinds: Map<string, string>;
  ready: boolean;
  onTab?: (tab: DomainTab) => void;
}) {
  switch (tab) {
    case 'overview':
      return <Overview evidence={evidence} names={names} onTab={onTab} />;
    case 'providers':
      return <ProvidersTab evidence={evidence} kinds={kinds} ready={ready} />;
    case 'prices':
      return <PricesTab offers={evidence.offers} names={names} />;
    case 'evidence':
      return <EvidenceTab evidence={evidence} names={names} />;
    case 'checks':
      return <ChecksTab evidence={evidence} />;
  }
}

function DomainTitle({ name, unicode, className }: { name: string; unicode: string | undefined; className?: string }) {
  const showUnicode = unicode && unicode !== name;
  return (
    <span className={cn('min-w-0 break-all font-mono', className)}>
      {showUnicode ? unicode : name}
      {showUnicode ? <span className="ml-2 text-sm font-normal text-muted-foreground">{name}</span> : null}
    </span>
  );
}

/** Domain details docked beside a results table. The chosen tab is kept while rows change. */
export function DomainDock({ name, tab, onTab, onClose }: { name: string; tab: DomainTab; onTab: (tab: DomainTab) => void; onClose: () => void }) {
  const { evidence, names, kinds, providersReady } = useDomainEvidence(name);
  const tabs = tabsFor(evidence.data, true);
  const active = tabs.includes(tab) ? tab : 'overview';
  return (
    <Dock
      label={name}
      onClose={onClose}
      header={
        <h2 className="flex min-h-control items-center text-sm font-semibold">
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
      <div className="shrink-0 px-4 pt-1">
        <DomainActions key={name} name={name} />
      </div>
      <Tabs key={name} value={active} onValueChange={(next) => onTab(next as DomainTab)} className="mt-3 flex min-h-0 flex-1 flex-col">
        <TabsList aria-label="Domain details" className="mx-4 flex shrink-0 sm:flex">
          {tabs.map((t) => (
            <TabsTrigger key={t} value={t} className="flex-1">
              {TAB_LABEL[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        {evidence.isPending ? (
          <div className="px-4 pt-4">
            <SkeletonRows rows={6} />
          </div>
        ) : evidence.isError ? (
          <div className="px-4 pt-4">
            <ErrorState error={evidence.error} onRetry={() => evidence.refetch()} />
          </div>
        ) : (
          tabs.map((t) => (
            <TabsContent key={t} value={t} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6 pt-4 data-[state=inactive]:hidden">
              <TabBody tab={t} evidence={evidence.data} names={names} kinds={kinds} ready={providersReady} onTab={onTab} />
            </TabsContent>
          ))
        )}
      </Tabs>
    </Dock>
  );
}

/** Full page: the overview beside tabs for providers, prices, evidence and checks. */
export function DomainPage({ name }: { name: string }) {
  const { evidence, names, kinds, providersReady } = useDomainEvidence(name);
  const [tab, setTab] = useState<DomainTab>('providers');
  const tabs = tabsFor(evidence.data, false);
  const active = tabs.includes(tab) ? tab : 'providers';
  const latest = evidence.data?.registry[0];
  return (
    <Page>
      <PageHeader
        leading={<BackButton fallback="/jobs" />}
        title={<DomainTitle name={name} unicode={evidence.data?.unicode} />}
        meta={latest ? <StatusLabel status={registryStatus(latest.outcome)} className="font-medium" /> : null}
        actions={<DomainActions name={name} />}
      />
      {evidence.isPending ? (
        <div className="grid gap-8 lg:grid-cols-[24rem_minmax(0,1fr)]">
          <SkeletonRows rows={8} />
          <SkeletonRows rows={8} />
        </div>
      ) : evidence.isError ? (
        <ErrorState error={evidence.error} onRetry={() => evidence.refetch()} />
      ) : (
        <div className="flex flex-col gap-8 lg:min-h-0 lg:flex-1 lg:flex-row lg:gap-10">
          <ScrollPane className="lg:w-96 lg:flex-none">
            <Overview evidence={evidence.data} names={names} onTab={(t) => t !== 'overview' && setTab(t)} />
          </ScrollPane>
          <Tabs value={active} onValueChange={(next) => setTab(next as DomainTab)} className="flex min-w-0 flex-1 flex-col lg:min-h-0">
            <TabsList aria-label="Domain details" className="shrink-0 self-start">
              {tabs.map((t) => (
                <TabsTrigger key={t} value={t}>
                  {TAB_LABEL[t]}
                </TabsTrigger>
              ))}
            </TabsList>
            {tabs.map((t) => (
              <TabsContent key={t} value={t} className="relative -mx-1 mt-3 flex flex-col px-1 data-[state=inactive]:hidden lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
                <TabBody tab={t} evidence={evidence.data} names={names} kinds={kinds} ready={providersReady} onTab={setTab} />
              </TabsContent>
            ))}
          </Tabs>
        </div>
      )}
    </Page>
  );
}
