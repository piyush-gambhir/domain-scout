'use client';

import { Download } from 'lucide-react';
import type { OperationResponse, PriceSeries } from '@domain-scout/contracts';
import { csvText, downloadText, fileStamp, scopeSlug } from '@/lib/download';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';

type HistoryEntry = OperationResponse<'listHistory'>['data'][number];

/** Export menu for a history view. Files are built from the rows on screen; nothing is requested. */
export function HistoryExportMenu({ label, disabled, onJson, onCsv }: { label: string; disabled: boolean; onJson: () => void; onCsv: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary" className="h-9" disabled={disabled} aria-label={label}>
          <Download />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onJson}>JSON</DropdownMenuItem>
        <DropdownMenuItem onSelect={onCsv}>CSV</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface Loaded<T> {
  contractVersion: string;
  rows: T[];
  total: number | null;
  /** False when more pages exist than were loaded into the view. */
  complete: boolean;
}

export interface PriceHistoryScope {
  suffix?: string;
  domain?: string;
  providerId?: string;
}

function priceFileName(scope: PriceHistoryScope, extension: string): string {
  return `domain-scout-price-history-${scopeSlug({ suffix: scope.suffix, domain: scope.domain, provider: scope.providerId })}-${fileStamp()}.${extension}`;
}

/** The comparable series shown, each with its points and gaps, as returned by the API. */
export function downloadPriceHistoryJson(scope: PriceHistoryScope, loaded: Loaded<PriceSeries>) {
  const doc = {
    kind: 'domain-scout-price-history',
    contractVersion: loaded.contractVersion,
    exportedAt: new Date().toISOString(),
    scope: { suffix: scope.suffix ?? null, domain: scope.domain ?? null, providerId: scope.providerId ?? null },
    loadedSeries: loaded.rows.length,
    totalSeries: loaded.total,
    complete: loaded.complete,
    series: loaded.rows,
  };
  downloadText(priceFileName(scope, 'json'), `${JSON.stringify(doc, null, 2)}\n`, 'application/json');
}

/** One row per observation, labeled with the comparable series it belongs to. */
export function downloadPriceHistoryCsv(scope: PriceHistoryScope, loaded: Loaded<PriceSeries>) {
  const header = [
    'seriesKey',
    'providerId',
    'scope',
    'purchasePath',
    'currency',
    'region',
    'termYears',
    'promotional',
    'offerId',
    'observedAt',
    'kind',
    'registration',
    'renewal',
    'transfer',
  ];
  const rows = loaded.rows.flatMap((s) =>
    s.points.map((p) => [s.key, s.providerId, s.scope, s.purchasePath, s.currency, s.region, s.termYears, s.promotional, p.offerId, p.observedAt, p.kind, p.registration, p.renewal, p.transfer]),
  );
  downloadText(priceFileName(scope, 'csv'), csvText(header, rows), 'text/csv');
}

export interface JobHistoryScope {
  q?: string;
  type?: string;
}

function jobFileName(scope: JobHistoryScope, extension: string): string {
  return `domain-scout-job-history-${scopeSlug({ search: scope.q, type: scope.type })}-${fileStamp()}.${extension}`;
}

export function downloadJobHistoryJson(scope: JobHistoryScope, loaded: Loaded<HistoryEntry>) {
  const doc = {
    kind: 'domain-scout-job-history',
    contractVersion: loaded.contractVersion,
    exportedAt: new Date().toISOString(),
    scope: { q: scope.q ?? null, type: scope.type ?? null },
    loadedJobs: loaded.rows.length,
    totalJobs: loaded.total,
    complete: loaded.complete,
    jobs: loaded.rows,
  };
  downloadText(jobFileName(scope, 'json'), `${JSON.stringify(doc, null, 2)}\n`, 'application/json');
}

export function downloadJobHistoryCsv(scope: JobHistoryScope, loaded: Loaded<HistoryEntry>) {
  const header = ['jobId', 'type', 'label', 'state', 'createdAt', 'finishedAt', 'total', 'unresolved', 'extensions', 'destinations', 'resumable'];
  const rows = loaded.rows.map((e) => [
    e.jobId,
    e.type,
    e.label,
    e.state,
    e.createdAt,
    e.finishedAt,
    e.total,
    e.unresolved,
    e.extensions.join(' '),
    e.destinations.join(' '),
    e.resumable,
  ]);
  downloadText(jobFileName(scope, 'csv'), csvText(header, rows), 'text/csv');
}
