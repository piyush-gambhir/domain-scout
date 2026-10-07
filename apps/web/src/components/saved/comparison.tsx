'use client';

import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import type { Comparison, ComparisonRequest, ComparisonRow, PurchasePath } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { PRICE_KIND } from '@/lib/labels';
import { formatDateTime, formatMoney, plural } from '@/lib/format';
import { qk } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { RelativeTime } from '../domain/time';
import { ErrorState } from '../states';
import { StatusDot } from '../status';
import { SkeletonRows } from '../ui/skeleton';

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

/** How costs are compared in a list: horizon, currency, purchase path and providers. */
export interface CompareOptions {
  /** Null: settings decide. */
  horizon: number | null;
  /** 'default': settings decide; 'original': keep each provider's currency; else convert with a saved rate. */
  currency: string;
  path: PurchasePath;
  providerIds: string[];
}

export const DEFAULT_COMPARE: CompareOptions = { horizon: null, currency: 'default', path: 'new_registration', providerIds: [] };

export function comparisonRequest(domains: string[], options: CompareOptions): ComparisonRequest {
  return {
    domains,
    purchasePath: options.path,
    ...(options.horizon !== null ? { horizonYears: options.horizon } : {}),
    ...(options.providerIds.length ? { providerIds: options.providerIds } : {}),
    ...(options.currency === 'original' ? { currency: null } : options.currency !== 'default' ? { currency: options.currency } : {}),
  };
}

function marked(list: Comparison['cheapest'] | undefined, row: ComparisonRow) {
  return (list ?? []).some((c) => c.domain === row.domain && c.currency === row.currency && c.providerId === row.providerId);
}

function Amount({ value, currency }: { value: string | null; currency: string | null }) {
  if (value === null) return <span className="text-muted-foreground">Unknown</span>;
  return <span className="tabular">{formatMoney(value, currency)}</span>;
}

const grid = 'grid grid-cols-[minmax(8rem,1.2fr)_minmax(6rem,1fr)_minmax(6rem,1fr)_minmax(7rem,1.2fr)_minmax(6rem,0.8fr)_3.5rem] items-center gap-x-4';

/**
 * Ownership cost by provider for one saved name, from retained offers only (nothing is sent to a
 * provider). The cheapest confirmed total is marked; totals with unknown tax or fees say so.
 */
export function ProviderComparison({ domain, options, names }: { domain: string; options: CompareOptions; names: Map<string, string> }) {
  const request = comparisonRequest([domain], options);
  const comparison = useQuery({
    queryKey: qk.comparison(request),
    queryFn: ({ signal }) => api.call('createComparison', { body: request, signal }).then((r) => r.data),
    staleTime: 30_000,
    retry: false,
  });
  if (comparison.isPending) return <SkeletonRows rows={3} className="py-2" />;
  if (comparison.isError) return <ErrorState error={comparison.error} onRetry={() => comparison.refetch()} />;
  const data = comparison.data;
  const rows = data.rows
    .filter((r) => r.domain === domain)
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || (names.get(a.providerId) ?? a.providerId).localeCompare(names.get(b.providerId) ?? b.providerId));
  const notes = new Map<string, string[]>();
  for (const row of rows) for (const note of row.notes) notes.set(note, [...(notes.get(note) ?? []), names.get(row.providerId) ?? row.providerId]);
  if (rows.length === 0) return <p className="py-2 text-sm text-muted-foreground">No retained prices for {domain}.</p>;
  return (
    <div className="flex flex-col gap-1 py-1" data-testid="comparison">
      <div role="table" aria-label={`Costs for ${domain}`} className="text-sm">
        <div role="row" className={cn(grid, 'h-7 px-2 text-xs text-muted-foreground')}>
          <span role="columnheader">Provider</span>
          <span role="columnheader">First payment</span>
          <span role="columnheader">{plural(data.horizonYears, 'year')}</span>
          <span role="columnheader">Missing</span>
          <span role="columnheader">Observed</span>
          <span role="columnheader">
            <span className="sr-only">Buy</span>
          </span>
        </div>
        {rows.map((row) => {
          const name = names.get(row.providerId) ?? row.providerId;
          const cheapest = marked(data.cheapest, row);
          const lowestSubtotal = !cheapest && marked(data.lowestSubtotal, row);
          return (
            <div key={`${row.providerId}-${row.offerId ?? 'none'}`} role="row" data-testid="comparison-row" className={cn(grid, 'min-h-10 rounded-md px-2 py-1', cheapest ? 'bg-background' : '')}>
              <span role="cell" className="min-w-0">
                <span className="block truncate font-medium">{name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {cheapest ? <span className="font-medium text-foreground">Cheapest total</span> : lowestSubtotal ? 'Lowest subtotal' : row.kind ? PRICE_KIND[row.kind] : 'No offer'}
                </span>
              </span>
              <span role="cell">
                <Amount value={row.initialCommitment} currency={row.currency} />
                {row.initialYears && row.initialYears > 1 ? <span className="block text-xs text-muted-foreground">{row.initialYears} year minimum</span> : null}
                {row.fx ? (
                  <span className="block text-xs text-muted-foreground" title={`${row.fx.source}, ${formatDateTime(row.fx.observedAt)}`}>
                    from {row.nativeCurrency} at {row.fx.rate}
                  </span>
                ) : null}
              </span>
              <span role="cell">
                <span className="font-medium">
                  <Amount value={row.horizonTotal} currency={row.currency} />
                </span>
                {row.subtotalOnly && row.horizonTotal !== null ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <StatusDot tone="caution" unresolved />
                    tax or fees unknown
                  </span>
                ) : row.horizonTotal !== null ? (
                  <span className="block text-xs text-muted-foreground">estimate</span>
                ) : null}
              </span>
              <span role="cell" className="text-xs text-muted-foreground">
                {row.missing.length ? row.missing.map((m) => MISSING_LABEL[m] ?? m).join(', ') : 'Nothing'}
              </span>
              <span role="cell" className="text-xs text-muted-foreground">
                {row.observedAt ? <RelativeTime iso={row.observedAt} /> : 'Unknown'}
              </span>
              <span role="cell" className="flex justify-end">
                {row.destination ? (
                  <a
                    href={row.destination}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="buy-link"
                    className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] font-medium transition-colors hover:bg-selected"
                  >
                    Buy
                    <ExternalLink aria-hidden className="size-3" />
                    <span className="sr-only"> {domain} at {name} (opens in a new tab)</span>
                  </a>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      {notes.size || data.limits.length ? (
        <ul className="flex flex-col gap-0.5 px-2 text-xs text-muted-foreground">
          {[...notes.entries()].map(([note, providers]) => (
            <li key={note}>
              {note}: {providers.join(', ')}
            </li>
          ))}
          {data.limits.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
