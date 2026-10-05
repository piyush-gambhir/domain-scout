'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Scale, Tag } from 'lucide-react';
import type { Comparison, ComparisonRequest, ComparisonRow, PurchasePath } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { PRICE_KIND } from '@/lib/labels';
import { formatDateTime, formatMoney, plural } from '@/lib/format';
import { qk, useProviders, useSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { ProviderRequestDialog } from '../actions/provider-request-dialog';
import { CheckedAt } from '../domain/time';
import { EmptyState, ErrorState } from '../states';
import { StatusDot } from '../status';
import { Button } from '../ui/button';
import { Field } from '../ui/label';
import { Segmented } from '../ui/segmented';
import { Select } from '../ui/select';
import { SkeletonRows } from '../ui/skeleton';
import { DomainsField, OutLink, ProviderFilter, usableDomains } from './shared';

const MISSING_LABEL: Record<string, string> = {
  registration: 'registration price',
  renewal: 'renewal price',
  transfer: 'transfer price',
  tax: 'tax',
  fees: 'fees',
  premium: 'premium status',
  promotion_eligibility: 'promotion eligibility',
  fx_rate: 'exchange rate',
};

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

const DEFAULT = '__default__';
const ORIGINAL = '__original__';

const thClass = 'pb-2 pr-4 text-xs font-medium text-muted-foreground';
const tdClass = 'py-2.5 pr-4 align-top';

function Money({ amount, currency }: { amount: string | null; currency: string | null }) {
  if (amount === null) return <span className="text-muted-foreground">Unknown</span>;
  return <span className="font-mono tabular">{formatMoney(amount, currency)}</span>;
}

type Marker = Comparison['cheapest'][number];

function marked(list: Marker[] | undefined, row: ComparisonRow): boolean {
  return (list ?? []).some((c) => c.domain === row.domain && c.currency === row.currency && c.providerId === row.providerId);
}

function ComparisonTable({ comparison, domain, names }: { comparison: Comparison; domain: string; names: Map<string, string> }) {
  const rows = comparison.rows
    .filter((r) => r.domain === domain)
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || (names.get(a.providerId) ?? a.providerId).localeCompare(names.get(b.providerId) ?? b.providerId));
  // The same note often applies to many providers; list it once with the providers it covers.
  const grouped = new Map<string, string[]>();
  for (const row of rows) for (const note of row.notes) grouped.set(note, [...(grouped.get(note) ?? []), names.get(row.providerId) ?? row.providerId]);
  const notes = [...grouped.entries()];
  return (
    <section aria-label={domain} className="min-w-0" data-testid="comparison-domain">
      <h3 className="mb-2 font-mono text-sm font-semibold">
        <Link href={`/domains/${encodeURIComponent(domain)}`} className="underline-offset-4 hover:underline">
          {domain}
        </Link>
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No retained offers.</p>
      ) : (
        <div className="relative -mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[54rem] text-left text-sm">
            <thead>
              <tr>
                <th scope="col" className={thClass}>
                  Provider
                </th>
                <th scope="col" className={thClass}>
                  Initial commitment
                </th>
                <th scope="col" className={thClass}>
                  {comparison.horizonYears} yr total
                </th>
                <th scope="col" className={thClass}>
                  Beyond horizon
                </th>
                <th scope="col" className={thClass}>
                  Missing
                </th>
                <th scope="col" className={thClass}>
                  Rank
                </th>
                <th scope="col" className={thClass}>
                  Observed
                </th>
                <th scope="col" className={thClass}>
                  <span className="sr-only">Purchase</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const name = names.get(row.providerId) ?? row.providerId;
                // Only the API's lists mark rows: `cheapest` holds confirmed totals, `lowestSubtotal` base subtotals.
                const cheapest = marked(comparison.cheapest, row);
                const lowestSubtotal = !cheapest && marked(comparison.lowestSubtotal, row);
                return (
                  <tr key={`${row.providerId}-${row.offerId ?? 'none'}`} data-testid="comparison-row" className={cn(cheapest && 'bg-hover')}>
                    <td className={cn(tdClass, 'rounded-l-md pl-2')}>
                      <span className="font-medium">{name}</span>
                      <span className="block text-xs text-muted-foreground">{row.kind ? PRICE_KIND[row.kind] : 'No offer'}</span>
                      {cheapest ? <span className="block text-xs font-semibold">Cheapest total in {row.currency}</span> : null}
                      {lowestSubtotal ? (
                        <span className="block max-w-44 text-xs">
                          <span className="font-semibold">Lowest subtotal in {row.currency}</span>
                          <span className="text-muted-foreground">, tax or fees unknown</span>
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      <Money amount={row.initialCommitment} currency={row.currency} />
                      {row.initialYears ? (
                        <span className="block text-xs text-muted-foreground">
                          {row.initialYears > 1 ? `${plural(row.initialYears, 'year')} minimum` : `for ${plural(row.initialYears, 'year')}`}
                        </span>
                      ) : null}
                      {row.fx ? (
                        <span className="block max-w-52 text-xs text-muted-foreground">
                          Converted from {row.nativeCurrency} at {row.fx.rate} ({row.fx.source}, {formatDateTime(row.fx.observedAt)})
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      <Money amount={row.horizonTotal} currency={row.currency} />
                      {row.horizonTotal !== null ? <span className="block text-xs text-muted-foreground">Estimate</span> : null}
                      {row.subtotalOnly && row.horizonTotal !== null ? (
                        <span className="mt-0.5 flex items-start gap-1.5 text-xs">
                          <StatusDot tone="caution" unresolved className="mt-1" />
                          Subtotal only, tax or fees unknown
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      {row.prepaidBeyondHorizon ? (
                        <>
                          <span>{plural(row.prepaidBeyondHorizon.years, 'year')} prepaid</span>
                          <span className="block text-xs">
                            <Money amount={row.prepaidBeyondHorizon.amount} currency={row.currency} />
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </td>
                    <td className={tdClass}>
                      {row.missing.length ? (
                        <span className="block max-w-44">{capitalize(row.missing.map((m) => MISSING_LABEL[m] ?? m).join(', '))}</span>
                      ) : (
                        <span className="text-muted-foreground">Nothing</span>
                      )}
                      {!row.complete ? <span className="block text-xs text-muted-foreground">Incomplete</span> : null}
                    </td>
                    <td className={cn(tdClass, 'font-mono tabular')}>
                      {row.rank === null ? (
                        <span className="font-sans text-muted-foreground">Not ranked</span>
                      ) : (
                        <>
                          {row.rank}
                          {row.subtotalOnly ? <span className="block font-sans text-xs text-muted-foreground">by subtotal</span> : null}
                        </>
                      )}
                    </td>
                    <td className={tdClass}>
                      {row.observedAt ? <CheckedAt iso={row.observedAt} freshness={row.freshness} /> : <span className="text-muted-foreground">Unknown</span>}
                    </td>
                    <td className={cn(tdClass, 'rounded-r-md')}>
                      {row.destination ? <OutLink href={row.destination} label="Open" provider={name} /> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {notes.length ? (
            <ul className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground" aria-label={`Notes for ${domain}`}>
              {notes.map(([note, providers]) => (
                <li key={note}>
                  {note}: {providers.join(', ')}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * Ownership cost comparison from retained offers. Nothing is sent to providers: it reads what earlier
 * catalog loads and quotes observed. Fresh quotes are a separate, explicit request.
 */
export function CostComparison({
  path,
  domainsText,
  onDomainsText,
  autoRun,
  children,
}: {
  path: 'registration' | 'transfer';
  domainsText: string;
  onDomainsText: (value: string) => void;
  /** Run once on mount when domains arrived in the URL. Comparisons read local data only. */
  autoRun: boolean;
  /** Extra per-domain sections under the comparison, e.g. transfer options. */
  children?: (domains: string[]) => React.ReactNode;
}) {
  const providers = useProviders();
  const settings = useSettings();
  const [horizon, setHorizon] = useState<number | null>(null);
  const [purchasePath, setPurchasePath] = useState<PurchasePath>(path === 'transfer' ? 'transfer' : 'new_registration');
  const [providerIds, setProviderIds] = useState<string[]>([]);
  // DEFAULT omits the field (settings decide), ORIGINAL sends null, a code converts with a saved rate.
  const [currency, setCurrency] = useState<string>(DEFAULT);
  // Domains from the URL compare right away; comparisons read retained data only.
  const [submitted, setSubmitted] = useState<ComparisonRequest | null>(() => {
    const initial = autoRun ? usableDomains(domainsText) : null;
    return initial ? { domains: initial, purchasePath: path === 'transfer' ? 'transfer' : 'new_registration' } : null;
  });
  const [quoteOpen, setQuoteOpen] = useState(false);

  const horizonYears = horizon ?? settings.data?.comparison.horizonYears ?? 3;
  const settingsCurrency = settings.data?.comparison.currency ?? null;
  const rateCurrencies = [...new Set((settings.data?.fxRates ?? []).flatMap((r) => [r.from, r.to]))].sort();
  const currencyOptions = [
    { value: DEFAULT, label: settingsCurrency ? `Default, ${settingsCurrency}` : 'Original currencies' },
    ...(settingsCurrency ? [{ value: ORIGINAL, label: 'Original currencies' }] : []),
    ...rateCurrencies.filter((c) => c !== settingsCurrency).map((c) => ({ value: c, label: c })),
  ];
  const domains = usableDomains(domainsText);

  // Horizon and currency are sent only when changed here; otherwise backend settings decide.
  const build = (): ComparisonRequest | null =>
    domains
      ? {
          domains,
          purchasePath,
          ...(horizon !== null ? { horizonYears: horizon } : {}),
          ...(providerIds.length ? { providerIds } : {}),
          ...(currency === ORIGINAL ? { currency: null } : currency !== DEFAULT ? { currency } : {}),
        }
      : null;

  const comparison = useQuery({
    queryKey: qk.comparison(submitted ?? {}),
    queryFn: ({ signal }) => api.call('createComparison', { body: submitted!, signal }).then((r) => r.data),
    enabled: submitted !== null,
    staleTime: 30_000,
    retry: false,
  });
  const names = new Map((providers.data ?? []).map((p) => [p.id, p.name]));
  const target = { count: domains?.length ?? 0, resolveDomains: async () => domains ?? [] };

  return (
    <div className="flex flex-col gap-8">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const request = build();
          if (!request) return;
          // The same request again means "reload": newly retained quotes or FX rates may change it.
          if (submitted && JSON.stringify(request) === JSON.stringify(submitted)) void comparison.refetch();
          else setSubmitted(request);
        }}
      >
        <DomainsField value={domainsText} onChange={onDomainsText} />
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <Field label="Horizon" htmlFor={`horizon-${path}`}>
            <Select
              id={`horizon-${path}`}
              value={String(horizonYears)}
              onValueChange={(v) => setHorizon(Number(v))}
              className="w-28"
              options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: plural(i + 1, 'year') }))}
            />
          </Field>
          {path === 'registration' ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Purchase path</span>
              <Segmented
                aria-label="Purchase path"
                value={purchasePath}
                onValueChange={setPurchasePath}
                options={[
                  { value: 'new_registration', label: 'New registration' },
                  { value: 'renewal', label: 'Renewal' },
                ]}
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Providers</span>
            <ProviderFilter providers={(providers.data ?? []).map((p) => ({ id: p.id, name: p.name }))} value={providerIds} onChange={setProviderIds} />
          </div>
          <Field label="Currency" htmlFor={`currency-${path}`}>
            <Select id={`currency-${path}`} value={currency} onValueChange={setCurrency} options={currencyOptions} className="w-48" />
          </Field>
          <Button type="submit" variant="primary" disabled={!domains}>
            <Scale />
            Compare
          </Button>
          <Button variant="secondary" disabled={!domains} onClick={() => setQuoteOpen(true)}>
            <Tag />
            {path === 'transfer' ? 'Request transfer prices' : 'Request quotes'}
          </Button>
        </div>
      </form>

      {submitted === null ? null : comparison.isPending ? (
        <SkeletonRows rows={4} />
      ) : comparison.isError ? (
        <ErrorState error={comparison.error} onRetry={() => comparison.refetch()} />
      ) : (
        <div className={cn('flex flex-col gap-10 transition-opacity', comparison.isFetching && 'opacity-60')}>
          <p className="text-sm text-muted-foreground">
            {plural(comparison.data.horizonYears, 'year')} horizon
            {comparison.data.currency ? ` in ${comparison.data.currency}` : ', original currencies'}
            {' · '}
            {formatDateTime(comparison.data.generatedAt)}
          </p>
          {comparison.data.rows.length === 0 ? <EmptyState>No retained offers for these domains.</EmptyState> : null}
          {comparison.data.rows.length > 0
            ? submitted.domains.map((domain) => <ComparisonTable key={domain} comparison={comparison.data} domain={domain} names={names} />)
            : null}
          {comparison.data.limits.length > 0 ? (
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground" aria-label="Limits">
              {comparison.data.limits.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      {submitted && children ? children(submitted.domains) : null}
      <ProviderRequestDialog
        key={path}
        open={quoteOpen}
        onOpenChange={setQuoteOpen}
        target={target}
        defaultOperation={path === 'transfer' ? 'transfer' : 'quote'}
      />
    </div>
  );
}
