'use client';

import { useEffect, useMemo, useRef } from 'react';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bookmark } from 'lucide-react';
import type { JobItem } from '@domain-scout/contracts';
import { FRESHNESS, PRICE_KIND, outcomeStatus } from '@/lib/labels';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DomainName } from '../domain/domain-name';
import { CheckedAt, RelativeTime, useFreshness } from '../domain/time';
import { StatusLabel, ToneText } from '../status';
import { Checkbox } from '../ui/checkbox';
import { Skeleton } from '../ui/skeleton';
import type { Selection } from './selection';

/** Matches --spacing-row (h-row) in globals.css. */
const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 32;

export interface ResultsTableProps {
  rows: JobItem[];
  total: number | null;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  isFetchingNextPage: boolean;
  selection: Selection;
  activeId: string | null;
  showTarget: boolean;
  /** Rows whose subject is a domain open the detail panel; name-check rows do not. */
  canOpen: (item: JobItem) => boolean;
  onOpen: (item: JobItem) => void;
  /** Extra space after the last row, e.g. under a floating selection toolbar. */
  bottomInset?: number;
}

function checkedTime(item: JobItem) {
  const registry = item.evidence.registry;
  if (registry) return { iso: registry.checkedAt, freshness: registry.freshness, staleAt: registry.staleAt };
  const confirmation = item.evidence.confirmation;
  if (confirmation) return { iso: confirmation.checkedAt, freshness: confirmation.freshness, staleAt: confirmation.staleAt };
  const offer = item.evidence.offers[0];
  if (offer) return { iso: offer.observedAt, freshness: offer.freshness, staleAt: offer.staleAt, expiresAt: offer.quoteExpiresAt };
  return { iso: item.finishedAt, freshness: null, staleAt: null };
}

/** One line: amount, kind, then freshness before the age so truncation never hides that a price is old. */
function BestPriceCell({ item }: { item: JobItem }) {
  const best = item.bestPrice;
  const freshness = useFreshness(best?.freshness ?? null, null);
  if (!best) return item.state === 'finished' ? <span className="text-muted-foreground">Unknown</span> : null;
  return (
    <span title={`${best.providerId}, ${best.years} year, ${best.source}`} className="flex min-w-0 items-baseline gap-1.5 truncate">
      <span className="font-mono tabular">{formatMoney(best.amount, best.currency)}</span>
      <span className="text-xs text-muted-foreground">{PRICE_KIND[best.kind]}</span>
      {freshness && freshness !== 'fresh' ? (
        <ToneText tone={FRESHNESS[freshness].tone} className="text-xs">
          {FRESHNESS[freshness].label}
        </ToneText>
      ) : null}
      {best.observedAt ? <RelativeTime iso={best.observedAt} className="truncate text-xs text-muted-foreground" /> : null}
    </span>
  );
}

/**
 * Calls a header or cell template as a plain function. flexRender mounts it as a component, and the
 * column definitions change with the selection, so every visible cell would remount and drop focus
 * (a toggled checkbox, or the row a closed detail panel returns to).
 */
function renderTemplate<P>(template: string | ((props: P) => React.ReactNode) | undefined, props: P): React.ReactNode {
  return typeof template === 'function' ? template(props) : (template ?? null);
}

/*
 * Columns follow the width of the table itself (container queries), so a docked panel or a narrow
 * window drops the least important columns instead of squeezing every one:
 * base: select, domain, outcome; @lg adds the best price; @2xl adds checked time, target and the shortlist mark.
 */
const GRID =
  'grid-cols-[2.25rem_minmax(0,1fr)_7.5rem] @lg:grid-cols-[2.25rem_minmax(0,1fr)_7.5rem_minmax(8rem,14rem)] @2xl:grid-cols-[2.25rem_minmax(0,1fr)_7.5rem_7.5rem_minmax(10rem,16rem)_1.5rem]';
const GRID_TARGET =
  'grid-cols-[2.25rem_minmax(0,1fr)_7.5rem] @lg:grid-cols-[2.25rem_minmax(0,1fr)_7.5rem_minmax(8rem,14rem)] @2xl:grid-cols-[2.25rem_minmax(0,1fr)_7rem_7.5rem_7.5rem_minmax(10rem,16rem)_1.5rem]';
const VISIBILITY: Record<string, string> = {
  price: 'hidden @lg:flex',
  checked: 'hidden @2xl:flex',
  target: 'hidden @2xl:flex',
  shortlist: 'hidden @2xl:flex',
};

/**
 * Virtualized results grid inside its own scroll container, which fills the rest of the page. Rows
 * come from server-side filtering, sorting and cursor pages; more pages load as it scrolls near the end.
 */
export function ResultsTable(props: ResultsTableProps) {
  const { rows, total, hasNextPage, fetchNextPage, isFetchingNextPage, selection, activeId, showTarget, canOpen, onOpen, bottomInset = 0 } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const loadedSelected = rows.length > 0 && rows.every((row) => selection.isSelected(row.id));
  const someSelected = rows.some((row) => selection.isSelected(row.id));

  const columns = useMemo<ColumnDef<JobItem>[]>(() => {
    const list: ColumnDef<JobItem>[] = [
      {
        id: 'select',
        header: () => (
          <Checkbox
            aria-label="Select loaded rows"
            checked={loadedSelected ? true : someSelected ? 'indeterminate' : false}
            onCheckedChange={(value) => selection.setLoaded(rows, value === true)}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label={`Select ${row.original.unicode || row.original.subject}`}
            checked={selection.isSelected(row.original.id)}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              selection.toggle(row.original, row.index, event.shiftKey, rows);
            }}
          />
        ),
      },
      {
        id: 'domain',
        header: () => 'Domain',
        cell: ({ row }) => {
          const item = row.original;
          const label = <DomainName ascii={item.subject} unicode={item.unicode} />;
          return canOpen(item) ? (
            <button
              type="button"
              data-row-focus
              className="flex min-w-0 max-w-full items-center rounded-sm text-left"
              onClick={(event) => {
                event.stopPropagation();
                onOpen(item);
              }}
            >
              {label}
            </button>
          ) : (
            <span data-row-focus tabIndex={-1} className="flex min-w-0 rounded-sm">
              {label}
            </span>
          );
        },
      },
    ];
    if (showTarget) {
      list.push({
        id: 'target',
        header: () => 'Target',
        cell: ({ row }) => <span className="truncate font-mono text-xs text-muted-foreground">{row.original.target ?? 'None'}</span>,
      });
    }
    list.push(
      {
        id: 'outcome',
        header: () => 'Outcome',
        cell: ({ row }) => {
          const item = row.original;
          const status = outcomeStatus(item.operation, item.outcome, item.state);
          return (
            <span title={[item.error?.message ?? item.evidence.registry?.reason.message, item.source].filter(Boolean).join(' · ') || undefined} className="min-w-0">
              <StatusLabel status={status} />
            </span>
          );
        },
      },
      {
        id: 'checked',
        header: () => 'Checked',
        cell: ({ row }) => {
          const time = checkedTime(row.original);
          return time.iso ? (
            <CheckedAt iso={time.iso} freshness={time.freshness} staleAt={time.staleAt} expiresAt={'expiresAt' in time ? time.expiresAt : null} className="truncate text-muted-foreground" />
          ) : null;
        },
      },
      {
        id: 'price',
        header: () => 'Best known price',
        cell: ({ row }) => <BestPriceCell item={row.original} />,
      },
      {
        id: 'shortlist',
        header: () => <span className="sr-only">Shortlisted</span>,
        cell: ({ row }) =>
          row.original.collectionIds.length > 0 ? (
            <span title={`In ${row.original.collectionIds.length} shortlist${row.original.collectionIds.length === 1 ? '' : 's'}`}>
              <Bookmark aria-hidden className="size-4 fill-current" />
              <span className="sr-only">In a shortlist</span>
            </span>
          ) : null,
      },
    );
    return list;
  }, [rows, selection, loadedSelected, someSelected, showTarget, canOpen, onOpen]);

  // React Compiler is not enabled; TanStack Table is used as documented.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel(), getRowId: (row) => row.id });
  const tableRows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: hasNextPage ? tableRows.length + 1 : tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // The sticky header sits above the rows inside the same scroll container, and rows scrolled
    // into view by keyboard must land below it, not under it.
    scrollMargin: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    paddingEnd: bottomInset,
  });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1]!.index : -1;

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastIndex >= tableRows.length - 20) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, lastIndex, tableRows.length, fetchNextPage]);

  // Row the keyboard is moving to. Repeated keys continue from it even before it has rendered and
  // taken focus, so holding an arrow key never skips or stalls.
  const pendingRow = useRef<number | null>(null);
  const focusRow = (index: number) => {
    if (index < 0 || index >= tableRows.length) return;
    pendingRow.current = index;
    virtualizer.scrollToIndex(index, { align: 'auto' });
    let tries = 0;
    const attempt = () => {
      if (pendingRow.current !== index) return;
      const target = listRef.current?.querySelector<HTMLElement>(`[data-row-index="${index}"] [data-row-focus]`);
      if (target) {
        target.focus({ preventScroll: true });
        pendingRow.current = null;
      } else if (tries++ < 10) requestAnimationFrame(attempt);
      else pendingRow.current = null;
    };
    requestAnimationFrame(attempt);
  };

  const grid = showTarget ? GRID_TARGET : GRID;
  const headers = table.getHeaderGroups()[0]?.headers ?? [];

  return (
    <div ref={scrollRef} data-testid="results-scroll" className="@container relative -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
      <div role="table" aria-label="Results" aria-rowcount={(total ?? tableRows.length) + 1} className="text-sm">
        <div role="rowgroup" className="sticky top-0 z-10 bg-background">
          <div role="row" aria-rowindex={1} className={cn('grid h-8 items-center gap-x-3 px-1 text-xs font-medium text-muted-foreground', grid)}>
            {headers.map((header) => (
              <div key={header.id} role="columnheader" className={cn('flex min-w-0 items-center', header.id === 'select' && 'justify-center', VISIBILITY[header.id])}>
                {renderTemplate(header.column.columnDef.header, header.getContext())}
              </div>
            ))}
          </div>
        </div>
        <div
          ref={listRef}
          role="rowgroup"
          className="relative"
          style={{ height: virtualizer.getTotalSize() }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const rowElement = (event.target as HTMLElement).closest<HTMLElement>('[data-row-index]');
            if (!rowElement) return;
            event.preventDefault();
            focusRow((pendingRow.current ?? Number(rowElement.dataset.rowIndex)) + (event.key === 'ArrowDown' ? 1 : -1));
          }}
        >
          {items.map((virtual) => {
            const row = tableRows[virtual.index];
            const style = { height: ROW_HEIGHT, transform: `translateY(${virtual.start - HEADER_HEIGHT}px)` };
            if (!row) {
              return (
                <div key="loader" role="row" className="absolute inset-x-0 top-0 flex items-center px-12" style={style}>
                  <Skeleton className="h-4 w-48" />
                </div>
              );
            }
            const item = row.original;
            const selected = selection.isSelected(item.id);
            return (
              <div
                key={row.id}
                role="row"
                aria-rowindex={virtual.index + 2}
                aria-selected={selected}
                data-row-index={virtual.index}
                data-active={activeId === item.id || undefined}
                onClick={() => canOpen(item) && onOpen(item)}
                className={cn(
                  'absolute inset-x-0 top-0 grid items-center gap-x-3 rounded-md px-1 transition-colors',
                  grid,
                  canOpen(item) && 'cursor-pointer',
                  selected ? 'bg-selected' : 'hover:bg-hover',
                  'data-[active]:bg-selected data-[active]:font-medium',
                )}
                style={style}
              >
                {row.getVisibleCells().map((cell) => (
                  <div
                    key={cell.id}
                    role="cell"
                    className={cn('flex min-w-0 items-center', cell.column.id === 'select' && 'justify-center', VISIBILITY[cell.column.id])}
                  >
                    {renderTemplate(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
