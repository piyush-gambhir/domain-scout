'use client';

import { useMemo, useRef, useState } from 'react';
import { Bookmark, Eye, RotateCw, ShoppingBag } from 'lucide-react';
import type { JobItem } from '@domain-scout/contracts';
import { formatMoney } from '@/lib/format';
import { type PriceLine, type PricesBySuffix, priceLines, rowPrice } from '@/lib/prices';
import type { WatchIndex } from '@/lib/saved';
import { cn } from '@/lib/utils';
import { RelativeTime } from '../domain/time';
import { StatusDot } from '../status';
import { Tooltip } from '../ui/tooltip';
import { BuyMenu } from './buy-menu';
import { itemStatus, problemReason, rowNote } from './cells';
import { labelOf, unicodeLabelOf } from './data';

export interface ResultActions {
  open: (domain: string) => void;
  toggleSave: (item: JobItem) => void;
  watch: (domain: string) => void;
  retry: (domain: string) => void;
}

interface GridProps {
  /** Pending rows read "Checking" while the search runs and "Not checked" after it stopped. */
  running: boolean;
  /** The list one keystroke saves to; the bookmark shows membership there. */
  savedListId: string | null;
  items: JobItem[];
  extensions: string[];
  prices: PricesBySuffix;
  currency: string;
  horizon: number;
  names: Map<string, string>;
  activeDomain: string | null;
  checking: Set<string>;
  watchIndex: WatchIndex;
  buyFor: string | null;
  onBuyFor: (domain: string | null) => void;
  actions: ResultActions;
}

const iconButton =
  'grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3.5';

function cellTip(item: JobItem, line: PriceLine | null, horizon: number) {
  const checkedAt = item.evidence.registry?.checkedAt ?? item.finishedAt;
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-mono">{item.subject}</span>
      {item.outcome === 'no_record' && line?.firstYear ? (
        <span>
          {line.providerName} · {formatMoney(line.firstYear, line.currency)} {line.firstYearTerm > 1 ? `for ${line.firstYearTerm} years` : 'first year'}
          {line.renewal ? ` · renews ${formatMoney(line.renewal, line.currency)}` : ''}
          {line.horizonTotal ? ` · ${horizon} years ${formatMoney(line.horizonTotal, line.currency)}` : ''}
        </span>
      ) : null}
      {item.outcome === 'no_record' && line?.observedAt ? (
        <span className="opacity-70">
          {line.kind === 'exact_quote' ? 'Quoted' : 'Price published'} <RelativeTime iso={line.observedAt} />
        </span>
      ) : null}
      {item.outcome === 'registered' && item.evidence.registry?.registration?.registrar ? <span>{item.evidence.registry.registration.registrar}</span> : null}
      {item.outcome && item.outcome !== 'no_record' && item.outcome !== 'registered' ? <span>{problemReason(item)}</span> : null}
      {checkedAt ? (
        <span className="opacity-70">
          Checked <RelativeTime iso={checkedAt} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * Names down, extensions across: the answer to "which of these are free and what do they cost" at a
 * glance. Free cells are tinted so they stand out without color; taken ones recede.
 */
export function ResultGrid({ running, savedListId, items, extensions, prices, currency, horizon, names, activeDomain, checking, watchIndex, buyFor, onBuyFor, actions }: GridProps) {
  const { labels, columns, cells, firstCell } = useMemo(() => {
    const labels: { key: string; display: string }[] = [];
    const seen = new Set<string>();
    const cols = [...extensions];
    const cells = new Map<string, JobItem>();
    for (const item of items) {
      const label = labelOf(item);
      if (!seen.has(label)) {
        seen.add(label);
        labels.push({ key: label, display: unicodeLabelOf(item) });
      }
      const suffix = item.suffix ?? '';
      if (!cols.includes(suffix)) cols.push(suffix);
      cells.set(`${label}|${suffix}`, item);
    }
    // Only extensions that hold at least one result get a column.
    const used = new Set(items.map((i) => i.suffix ?? ''));
    const columns = cols.filter((c) => used.has(c));
    let firstCell = { r: 0, c: 0 };
    outer: for (let r = 0; r < labels.length; r++) {
      for (let c = 0; c < columns.length; c++) {
        if (cells.has(`${labels[r]!.key}|${columns[c]}`)) {
          firstCell = { r, c };
          break outer;
        }
      }
    }
    return { labels, columns, cells, firstCell };
  }, [items, extensions]);

  const [focus, setFocus] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const gridRef = useRef<HTMLDivElement>(null);
  const tabbable = cells.has(`${labels[focus.r]?.key}|${columns[focus.c]}`) ? focus : firstCell;

  const move = (r: number, c: number, dr: number, dc: number) => {
    let nr = r + dr;
    let nc = c + dc;
    while (nr >= 0 && nr < labels.length && nc >= 0 && nc < columns.length) {
      if (cells.has(`${labels[nr]!.key}|${columns[nc]}`)) {
        setFocus({ r: nr, c: nc });
        gridRef.current?.querySelector<HTMLElement>(`[data-cell="${nr}:${nc}"]`)?.focus();
        return;
      }
      nr += dr;
      nc += dc;
    }
  };

  const template = `minmax(8rem, 13rem) repeat(${columns.length}, minmax(8.5rem, 1fr))`;
  // Scroll sideways only when every column at its minimum no longer fits.
  const minWidth = `calc(8rem + ${columns.length} * 8.5rem + ${columns.length} * 0.375rem)`;

  return (
    <div ref={gridRef} data-testid="results-grid" className="relative -mx-1 min-h-0 flex-1 overflow-auto px-1 pb-4">
      <div role="grid" aria-label="Results by name and extension" aria-rowcount={labels.length + 1} aria-colcount={columns.length + 1} style={{ minWidth }}>
        <div role="row" className="sticky top-0 z-10 grid h-9 items-center gap-1.5 bg-background" style={{ gridTemplateColumns: template }}>
          <span role="columnheader" className="sticky left-0 z-10 bg-background px-2 text-xs font-medium text-muted-foreground">
            Name
          </span>
          {columns.map((suffix) => (
            <span key={suffix} role="columnheader" className="px-2.5 text-[13px] font-medium text-muted-foreground">
              .{suffix}
            </span>
          ))}
        </div>
        {labels.map((label, r) => (
          <div key={label.key} role="row" className="grid items-stretch gap-1.5 py-[3px]" style={{ gridTemplateColumns: template }}>
            <span role="rowheader" className="sticky left-0 z-[5] flex min-w-0 items-center bg-background px-2 text-sm font-medium" title={label.display}>
              <span className="truncate">{label.display}</span>
            </span>
            {columns.map((suffix, c) => {
              const item = cells.get(`${label.key}|${suffix}`);
              if (!item) {
                return (
                  <span key={suffix} role="gridcell" aria-label={`${label.display}.${suffix} not searched`} className="flex h-14 items-center px-2.5 text-muted-foreground/50">
                    <span aria-hidden>·</span>
                  </span>
                );
              }
              const lines = item.suffix ? priceLines(item.subject, prices.get(item.suffix), [], horizon, names) : [];
              const line = rowPrice(item, prices, currency);
              return (
                <GridCell
                  key={suffix}
                  item={item}
                  row={r}
                  col={c}
                  tabbable={tabbable.r === r && tabbable.c === c}
                  active={activeDomain === item.subject}
                  checking={checking.has(item.subject) || (running && item.outcome === null)}
                  watched={watchIndex.has(item.subject)}
                  saved={savedListId !== null && item.collectionIds.includes(savedListId)}
                  line={line}
                  lines={lines}
                  horizon={horizon}
                  buyOpen={buyFor === item.subject}
                  onBuyOpen={(open) => onBuyFor(open ? item.subject : null)}
                  onFocus={() => setFocus({ r, c })}
                  onMove={(dr, dc) => move(r, c, dr, dc)}
                  actions={actions}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function GridCell({
  item,
  row,
  col,
  tabbable,
  active,
  checking,
  watched,
  saved,
  line,
  lines,
  horizon,
  buyOpen,
  onBuyOpen,
  onFocus,
  onMove,
  actions,
}: {
  item: JobItem;
  row: number;
  col: number;
  tabbable: boolean;
  active: boolean;
  checking: boolean;
  watched: boolean;
  saved: boolean;
  line: PriceLine | null;
  lines: PriceLine[];
  horizon: number;
  buyOpen: boolean;
  onBuyOpen: (open: boolean) => void;
  onFocus: () => void;
  onMove: (dr: number, dc: number) => void;
  actions: ResultActions;
}) {
  const mainRef = useRef<HTMLButtonElement>(null);
  const status = itemStatus(item, checking);
  const free = !checking && item.outcome === 'no_record';
  const taken = !checking && item.outcome === 'registered';
  const problem = !checking && !free && !taken && item.outcome !== null;
  const note = checking ? null : rowNote(item, line);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const delta = arrows[event.key];
    if (delta) {
      event.preventDefault();
      onMove(delta[0], delta[1]);
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      actions.toggleSave(item);
    } else if (key === 'b' && free) {
      event.preventDefault();
      onBuyOpen(true);
    } else if (key === 'w') {
      event.preventDefault();
      actions.watch(item.subject);
    }
  };

  return (
    <div
      role="gridcell"
      className={cn(
        'group/cell relative flex h-14 min-w-0 rounded-lg transition-colors',
        free ? 'bg-input hover:bg-selected' : 'hover:bg-hover',
        active && 'bg-selected shadow-[inset_0_0_0_2px_var(--control)] hover:bg-selected',
      )}
      data-testid="grid-cell"
      data-domain={item.subject}
      data-status={checking ? 'checking' : (item.outcome ?? 'pending')}
    >
      <Tooltip content={cellTip(item, line, horizon)}>
        <button
          ref={mainRef}
          type="button"
          aria-busy={checking || undefined}
          data-cell={`${row}:${col}`}
          tabIndex={tabbable ? 0 : -1}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          onClick={() => actions.open(item.subject)}
          aria-label={`${item.subject}: ${status.label}${free && line?.firstYear ? `, ${formatMoney(line.firstYear, line.currency)} first year` : ''}`}
          className="focus-inset flex min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-lg px-2.5 text-left outline-offset-[-2px]"
        >
          <span className={cn('flex min-w-0 items-center gap-1.5 text-[13px]', free ? 'font-medium text-foreground' : 'text-muted-foreground')}>
            <StatusDot tone={status.tone} unresolved={status.unresolved} className={cn(checking && 'motion-safe:animate-pulse')} />
            <span className="truncate">{status.label}</span>
          </span>
          {free && line?.firstYear ? (
            <span className="truncate pl-3.5 text-sm font-semibold tabular text-foreground">
              {formatMoney(line.firstYear, line.currency)}
              {line.firstYearTerm > 1 ? <span className="text-[11px] font-normal text-muted-foreground"> /{line.firstYearTerm} yr</span> : null}
            </span>
          ) : note ? (
            <span className="truncate pl-3.5 text-xs text-muted-foreground">{note}</span>
          ) : null}
        </button>
      </Tooltip>
      <div
        className={cn(
          // Bottom right, over the short second line; the cell tint backs it so text never shows through.
          'absolute bottom-1 right-1 flex items-center gap-0.5 rounded-md p-0.5 opacity-0 transition-opacity group-focus-within/cell:opacity-100 group-hover/cell:opacity-100',
          free ? 'bg-input group-hover/cell:bg-selected' : 'bg-background group-hover/cell:bg-hover',
          active && 'bg-selected group-hover/cell:bg-selected',
          (saved || buyOpen) && 'opacity-100',
        )}
      >
        <button type="button" tabIndex={-1} aria-label={saved ? `Unsave ${item.subject}` : `Save ${item.subject}`} aria-pressed={saved} onClick={() => actions.toggleSave(item)} className={iconButton}>
          <Bookmark className={cn(saved && 'fill-current text-foreground')} />
        </button>
        {free ? (
          <BuyMenu
            domain={item.subject}
            suffix={item.suffix ?? ''}
            lines={lines}
            horizon={horizon}
            open={buyOpen}
            onOpenChange={onBuyOpen}
            returnFocus={() => mainRef.current}
            trigger={
              <button type="button" tabIndex={-1} aria-label={`Buy ${item.subject}`} className={iconButton}>
                <ShoppingBag />
              </button>
            }
          />
        ) : null}
        {taken ? (
          <button type="button" tabIndex={-1} aria-label={watched ? `Watching ${item.subject}` : `Watch ${item.subject}`} aria-pressed={watched} onClick={() => actions.watch(item.subject)} className={iconButton}>
            <Eye className={cn(watched && 'text-foreground')} />
          </button>
        ) : null}
        {problem ? (
          <button type="button" tabIndex={-1} aria-label={`Check ${item.subject} again`} onClick={() => actions.retry(item.subject)} className={iconButton}>
            <RotateCw />
          </button>
        ) : null}
      </div>
    </div>
  );
}
