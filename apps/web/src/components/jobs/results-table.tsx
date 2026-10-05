'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Bookmark } from 'lucide-react';
import type { JobItem } from '@domain-scout/contracts';
import { outcomeStatus } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { DomainName } from '../domain/domain-name';
import { Price } from '../domain/price';
import { CheckedAt } from '../domain/time';
import { StatusLabel } from '../status';
import { Checkbox } from '../ui/checkbox';
import { Skeleton } from '../ui/skeleton';
import type { Selection } from './selection';

const ROW_HEIGHT = 44;

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

// Column widths per breakpoint; cells below `sm` hide checked time, price and shortlist.
const GRID = 'grid-cols-[2.75rem_minmax(0,1fr)_8.5rem] sm:grid-cols-[2.75rem_minmax(0,1fr)_9.5rem_9rem_minmax(7rem,11rem)_2.5rem]';
const GRID_TARGET =
  'grid-cols-[2.75rem_minmax(0,1fr)_8.5rem] sm:grid-cols-[2.75rem_minmax(0,1fr)_8rem_9.5rem_9rem_minmax(7rem,11rem)_2.5rem]';
const WIDE_ONLY = new Set(['checked', 'price', 'shortlist', 'target']);

/**
 * Virtualized results grid. Rows come from server-side filtering, sorting and cursor pages; more
 * pages load as the window scrolls near the end. Window scrolling keeps the page header, progress
 * and filters in normal flow.
 */
export function ResultsTable(props: ResultsTableProps) {
  const { rows, total, hasNextPage, fetchNextPage, isFetchingNextPage, selection, activeId, showTarget, canOpen, onOpen } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const measure = () => setScrollMargin(element.getBoundingClientRect().top + window.scrollY);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

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
          const label = <DomainName ascii={item.subject} unicode={item.unicode} className="text-[13px]" />;
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
            <span title={item.error?.message ?? item.evidence.registry?.reason.message} className="min-w-0">
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
          return time.iso ? <CheckedAt iso={time.iso} freshness={time.freshness} staleAt={time.staleAt} expiresAt={'expiresAt' in time ? time.expiresAt : null} className="truncate text-muted-foreground" /> : null;
        },
      },
      {
        id: 'price',
        header: () => 'Best known price',
        cell: ({ row }) => {
          const best = row.original.bestPrice;
          if (!best) return row.original.state === 'finished' ? <span className="text-muted-foreground">Unknown</span> : null;
          return (
            <span title={`${best.providerId}, ${best.years} year`} className="min-w-0">
              <Price amount={best.amount} currency={best.currency} kind={best.kind} />
            </span>
          );
        },
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

  const virtualizer = useWindowVirtualizer({
    count: hasNextPage ? tableRows.length + 1 : tableRows.length,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin,
  });
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1]!.index : -1;

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastIndex >= tableRows.length - 20) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, lastIndex, tableRows.length, fetchNextPage]);

  const focusRow = (index: number) => {
    if (index < 0 || index >= tableRows.length) return;
    virtualizer.scrollToIndex(index, { align: 'auto' });
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-row-index="${index}"] [data-row-focus]`)?.focus();
    });
  };

  const grid = showTarget ? GRID_TARGET : GRID;
  const headers = table.getHeaderGroups()[0]?.headers ?? [];

  return (
    <div role="table" aria-label="Results" aria-rowcount={(total ?? tableRows.length) + 1} className="text-sm">
      <div role="rowgroup" className="sticky top-12 z-10 bg-background/95 backdrop-blur md:top-0">
        <div role="row" aria-rowindex={1} className={cn('grid h-10 items-center gap-x-3 px-1 text-xs font-medium text-muted-foreground', grid)}>
          {headers.map((header) => (
            <div
              key={header.id}
              role="columnheader"
              className={cn('flex min-w-0 items-center', header.id === 'select' && 'justify-center', WIDE_ONLY.has(header.id) && 'hidden sm:flex')}
            >
              {flexRender(header.column.columnDef.header, header.getContext())}
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
          focusRow(Number(rowElement.dataset.rowIndex) + (event.key === 'ArrowDown' ? 1 : -1));
        }}
      >
        {items.map((virtual) => {
          const row = tableRows[virtual.index];
          const style = { height: ROW_HEIGHT, transform: `translateY(${virtual.start - virtualizer.options.scrollMargin}px)` };
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
                  className={cn('flex min-w-0 items-center', cell.column.id === 'select' && 'justify-center', WIDE_ONLY.has(cell.column.id) && 'hidden sm:flex')}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
