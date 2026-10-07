'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { PriceSeries } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { PRICE_KIND, PURCHASE_PATH } from '@/lib/labels';
import { formatDateTime, formatMoney, plural } from '@/lib/format';
import { qk, useProviders } from '@/lib/queries';
import { useDebounced } from '@/lib/use-debounced';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, ScrollPane } from '../states';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Field } from '../ui/label';
import { Select } from '../ui/select';
import { SkeletonRows } from '../ui/skeleton';
import { HistoryExportMenu, downloadPriceHistoryCsv, downloadPriceHistoryJson } from './history-export';
import { PriceChart, primaryField } from './price-chart';

const ANY = '__any__';
const POINT_PREVIEW = 8;

function Amount({ value, currency }: { value: string | null; currency: string }) {
  return value === null ? <span className="text-muted-foreground">Unknown</span> : <span className="font-mono tabular">{formatMoney(value, currency)}</span>;
}

function SeriesBlock({ series, providerName }: { series: PriceSeries; providerName: string }) {
  const [all, setAll] = useState(false);
  const field = primaryField(series);
  const points = [...series.points].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  const shown = all ? points : points.slice(0, POINT_PREVIEW);
  const scope = series.scope.includes('.') ? series.scope : `.${series.scope}`;
  return (
    <article aria-label={`${providerName} ${scope}`} data-testid="price-series">
      <header className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-medium">{providerName}</h3>
        <span className="font-mono text-sm">{scope}</span>
        <span className="text-sm text-muted-foreground">
          {[
            PURCHASE_PATH[series.purchasePath],
            PRICE_KIND[series.kind],
            series.currency,
            series.region ?? 'No region',
            `${series.termYears} yr term`,
            series.promotional ? promotionLabel(series.promotion) : 'Standard',
          ].join(' · ')}
        </span>
      </header>
      <PriceChart series={series} field={field} />
      {series.gaps.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-0.5 text-xs text-muted-foreground">
          {series.gaps.map((gap) => (
            <li key={`${gap.from}-${gap.to}`}>
              No observations from {formatDateTime(gap.from)} to {formatDateTime(gap.to)}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="relative -mx-1 mt-2 overflow-x-auto px-1">
        <table className="w-full min-w-[30rem] text-left text-sm">
          <caption className="sr-only">Observations for {providerName} {scope}</caption>
          <thead>
            <tr className="text-xs text-muted-foreground">
              {['Observed', 'Kind', 'Registration', 'Renewal', 'Transfer'].map((h) => (
                <th key={h} scope="col" className={cn('pb-1 pr-4 font-medium', h.toLowerCase() === field && 'text-foreground')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((point) => (
              <tr key={point.offerId}>
                <td className="py-1 pr-4 text-muted-foreground">{formatDateTime(point.observedAt)}</td>
                <td className="py-1 pr-4">{PRICE_KIND[point.kind]}</td>
                <td className="py-1 pr-4">
                  <Amount value={point.registration} currency={series.currency} />
                </td>
                <td className="py-1 pr-4">
                  <Amount value={point.renewal} currency={series.currency} />
                </td>
                <td className="py-1 pr-4">
                  <Amount value={point.transfer} currency={series.currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {points.length > POINT_PREVIEW ? (
        <Button size="sm" variant="link" className="mt-2 text-muted-foreground" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${plural(points.length, 'observation')}`}
        </Button>
      ) : null}
    </article>
  );
}

/** Observed price series, one block per comparable series. Nothing is fetched from providers here. */
export function PriceHistory() {
  const providers = useProviders();
  // A notice or a domain panel can link here for one extension (?suffix=com).
  const initialSuffix = useSearchParams().get('suffix') ?? '';
  const [suffix, setSuffix] = useState(initialSuffix);
  const [domain, setDomain] = useState('');
  const [providerId, setProviderId] = useState(ANY);
  // Debounce a string key: a fresh object each render would never settle.
  const queryKey = useDebounced(
    JSON.stringify({
      suffix: suffix.trim().toLowerCase().replace(/^\.+/, '') || undefined,
      domain: domain.trim().toLowerCase() || undefined,
      providerId: providerId === ANY ? undefined : providerId,
    }),
    350,
  );
  const query = useMemo(() => JSON.parse(queryKey) as { suffix?: string; domain?: string; providerId?: string }, [queryKey]);
  const history = useInfiniteQuery({
    queryKey: qk.priceHistory(query),
    queryFn: ({ pageParam, signal }) => api.call('getPriceHistory', { query: { ...query, cursor: pageParam, limit: 50 }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
  });
  const series = history.data?.pages.flatMap((p) => p.data) ?? [];
  const names = new Map((providers.data ?? []).map((p) => [p.id, p.name]));
  // Exports describe exactly what is shown, so they wait while another filter is loading.
  const exportable = series.length > 0 && !history.isPlaceholderData && !history.isFetching;
  const loaded = () => ({
    contractVersion: history.data?.pages[0]?.contractVersion ?? '',
    rows: series,
    total: history.data?.pages[0]?.total ?? null,
    complete: !history.hasNextPage,
  });

  return (
    <section aria-label="Price history" className="flex min-w-0 flex-col gap-3 lg:min-h-0 lg:flex-1">
      <div className="flex shrink-0 flex-wrap items-end gap-3">
        <div className="grid w-full gap-3 sm:w-auto sm:grid-cols-[8rem_14rem_12rem]" role="search" aria-label="Filter price history">
          <Field label="Extension" htmlFor="ph-suffix">
            <Input id="ph-suffix" value={suffix} placeholder="com" spellCheck={false} autoCapitalize="off" onChange={(e) => setSuffix(e.target.value)} className="font-mono" />
          </Field>
          <Field label="Domain" htmlFor="ph-domain">
            <Input id="ph-domain" value={domain} spellCheck={false} autoCapitalize="off" onChange={(e) => setDomain(e.target.value)} className="font-mono" />
          </Field>
          <Field label="Provider" htmlFor="ph-provider">
            <Select
              id="ph-provider"
              value={providerId}
              onValueChange={setProviderId}
              options={[{ value: ANY, label: 'Any provider' }, ...(providers.data ?? []).filter((p) => p.kind === 'registrar').map((p) => ({ value: p.id, label: p.name }))]}
            />
          </Field>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {series.length > 0 ? <span className="px-1 text-sm text-muted-foreground tabular">{plural(history.data?.pages[0]?.total ?? series.length, 'series', 'series')}</span> : null}
          <HistoryExportMenu
            label="Export price history"
            disabled={!exportable}
            onJson={() => downloadPriceHistoryJson(query, loaded())}
            onCsv={() => downloadPriceHistoryCsv(query, loaded())}
          />
        </div>
      </div>
      {history.isPending ? (
        <SkeletonRows rows={6} />
      ) : history.isError ? (
        <ErrorState error={history.error} onRetry={() => history.refetch()} />
      ) : series.length === 0 ? (
        <EmptyState>No comparable observations</EmptyState>
      ) : (
        <ScrollPane>
          <div className={cn('flex flex-col gap-10 pb-2 transition-opacity', history.isPlaceholderData && 'opacity-60')} aria-busy={history.isPlaceholderData}>
            {series.map((s) => (
              <SeriesBlock key={s.key} series={s} providerName={names.get(s.providerId) ?? s.providerId} />
            ))}
          </div>
          {history.hasNextPage ? (
            <div className="flex justify-center py-2">
              <Button variant="ghost" disabled={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>
                Load more
              </Button>
            </div>
          ) : null}
        </ScrollPane>
      )}
    </section>
  );
}

/** Campaign conditions keep promotional series distinguishable at a glance. */
function promotionLabel(promotion: PriceSeries['promotion']): string {
  if (!promotion) return 'Promotional';
  const parts = [promotion.description ?? 'Promotional'];
  if (promotion.requiresTermYears) parts.push(`requires ${promotion.requiresTermYears} yr`);
  if (promotion.restrictions) parts.push(promotion.restrictions);
  if (promotion.expiresAt) parts.push(`until ${formatDateTime(promotion.expiresAt)}`);
  return parts.join(', ');
}
