'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bookmark, ChevronRight, Eye, PanelRight, RotateCw, Search, ShoppingBag, SlidersHorizontal, X } from 'lucide-react';
import type { Job, JobItem } from '@domain-scout/contracts';
import { errorMessage } from '@/lib/api';
import { formatCount } from '@/lib/format';
import type { RegistryGroup } from '@/lib/labels';
import { type PricesBySuffix, priceLines, rowPrice } from '@/lib/prices';
import type { WatchIndex } from '@/lib/saved';
import { cn } from '@/lib/utils';
import { DomainName } from '../domain/domain-name';
import { RelativeTime } from '../domain/time';
import { CONFIRMATION_OPTIONS, MultiSelect } from '../jobs/filters';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Segmented } from '../ui/segmented';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { BuyMenu } from './buy-menu';
import { Money, ResultStatus, rowNote } from './cells';
import { type ListFilters, type ListSort, groupAllowed, groupCounts, resolveSection, sectionFilter, useSectionResults, withOverride } from './data';
import type { ResultActions } from './result-grid';

const ROW = 40;
const HEADER = 44;

export const GROUP_LABEL: Record<RegistryGroup, string> = {
  free: 'Not registered',
  taken: 'Taken',
  problem: "Couldn't check",
  pending: 'Not checked yet',
};

type Entry =
  | { kind: 'header'; group: RegistryGroup }
  | { kind: 'error'; group: RegistryGroup }
  | { kind: 'row'; group: RegistryGroup; item: JobItem }
  | { kind: 'more'; group: RegistryGroup }
  | { kind: 'empty'; group: RegistryGroup };

export type ListSelection = Map<string, JobItem>;

/*
 * Columns follow the width of the list (container queries), so a docked panel or a narrow window
 * drops the least important ones first.
 */
const COLS =
  'grid-cols-[2rem_minmax(0,1fr)_7.5rem] @md:grid-cols-[2rem_minmax(0,1fr)_8.5rem_5.5rem] @2xl:grid-cols-[2rem_minmax(0,1fr)_8.5rem_minmax(8rem,11rem)_5.5rem] @4xl:grid-cols-[2rem_minmax(0,1fr)_8.5rem_minmax(8rem,11rem)_6rem_6.5rem_5.5rem] @5xl:grid-cols-[2rem_minmax(0,1fr)_8.5rem_minmax(8rem,11rem)_6rem_6.5rem_6.5rem_5.5rem]';
// Narrow panes keep domain and status; a tap opens the full domain page with every action.
const SHOW = { price: 'hidden @2xl:flex', more: 'hidden @4xl:flex', checked: 'hidden @5xl:flex', actions: 'hidden @md:flex' };

export function ListFilterBar({ filters, onChange, suffixes, currency }: { filters: ListFilters; onChange: (next: ListFilters) => void; suffixes: string[]; currency: string }) {
  const [q, setQ] = useState(filters.q ?? '');
  const onChangeRef = useRef(onChange);
  const filtersRef = useRef(filters);
  useEffect(() => {
    onChangeRef.current = onChange;
    filtersRef.current = filters;
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((filtersRef.current.q ?? '') !== q.trim()) onChangeRef.current({ ...filtersRef.current, q: q.trim() || undefined });
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  const [price, setPrice] = useState(filters.maxPrice ?? '');
  const [length, setLength] = useState(filters.maxLength ? String(filters.maxLength) : '');
  const restored = Boolean(filters.outcomes?.length || filters.collectionId || filters.resolved !== undefined);
  const active = Boolean(filters.q || filters.suffixes?.length || filters.maxPrice || filters.maxLength || filters.confirmations?.length || filters.saved !== undefined || restored);
  const more = (filters.confirmations?.length ? 1 : 0) + (filters.saved !== undefined ? 1 : 0);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5" role="search" aria-label="Filter results">
      <div className="relative w-full sm:w-52">
        <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" aria-label="Filter names" placeholder="Filter names" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
      </div>
      <MultiSelect
        label="Extension"
        options={suffixes.map((s) => ({ value: s, label: `.${s}` }))}
        value={filters.suffixes}
        onChange={(next) => onChange({ ...filters, suffixes: next })}
      />
      <label className="flex h-control items-center gap-1.5 rounded-md bg-input pl-2.5 pr-1 text-sm text-muted-foreground">
        Up to
        <input
          aria-label={`Maximum first-year price in ${filters.currency ?? currency}`}
          inputMode="decimal"
          placeholder={filters.currency ?? currency}
          value={price}
          onChange={(e) => {
            const value = e.target.value.trim();
            setPrice(value);
            if (value === '') onChange({ ...filters, maxPrice: undefined });
            else if (/^\d+(\.\d+)?$/.test(value)) onChange({ ...filters, maxPrice: value });
          }}
          className="h-6 w-16 rounded bg-background/60 px-1.5 text-foreground tabular outline-none placeholder:text-muted-foreground"
        />
      </label>
      <label className="flex h-control items-center gap-1.5 rounded-md bg-input pl-2.5 pr-1 text-sm text-muted-foreground">
        Length ≤
        <input
          aria-label="Maximum name length"
          inputMode="numeric"
          value={length}
          onChange={(e) => {
            const value = e.target.value.trim();
            setLength(value);
            const n = Number(value);
            onChange({ ...filters, maxLength: value && Number.isInteger(n) && n >= 1 && n <= 63 ? n : undefined });
          }}
          className="h-6 w-10 rounded bg-background/60 px-1.5 text-foreground tabular outline-none"
        />
      </label>
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant={more ? 'primary' : 'secondary'} aria-label={more ? `More filters, ${more} active` : 'More filters'}>
            <SlidersHorizontal />
            More
          </Button>
        </PopoverTrigger>
        <PopoverContent className="flex w-72 flex-col gap-3 p-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Saved</span>
            <Segmented
              aria-label="Saved"
              size="sm"
              value={filters.saved === undefined ? 'any' : filters.saved ? 'saved' : 'not'}
              onValueChange={(v) => onChange({ ...filters, saved: v === 'any' ? undefined : v === 'saved' })}
              options={[
                { value: 'any', label: 'Any' },
                { value: 'saved', label: 'Saved' },
                { value: 'not', label: 'Not saved' },
              ]}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Provider check</span>
            <MultiSelect
              label={filters.confirmations?.length ? 'Provider says' : 'Any provider answer'}
              options={CONFIRMATION_OPTIONS}
              value={filters.confirmations}
              onChange={(next) => onChange({ ...filters, confirmations: next as ListFilters['confirmations'] })}
            />
          </div>
        </PopoverContent>
      </Popover>
      {restored ? <span className="text-xs text-muted-foreground">Saved search filter</span> : null}
      {active ? (
        <Button
          size="sm"
          variant="quiet"
          onClick={() => {
            setQ('');
            setPrice('');
            setLength('');
            onChange({ sort: filters.sort });
          }}
        >
          <X />
          Clear
        </Button>
      ) : null}
      <Select
        aria-label="Order"
        value={filters.sort ?? 'price'}
        onValueChange={(sort) => onChange({ ...filters, sort: sort === 'price' ? undefined : (sort as ListSort) })}
        className="ml-auto w-40"
        options={[
          { value: 'price', label: 'Cheapest first' },
          { value: 'length', label: 'Shortest first' },
          { value: 'domain', label: 'A to Z' },
          { value: 'input', label: 'As entered' },
        ]}
      />
    </div>
  );
}

interface ListProps {
  job: Job;
  /** The list one keystroke saves to; the bookmark shows membership there. */
  savedListId: string | null;
  filters: ListFilters;
  prices: PricesBySuffix;
  currency: string;
  horizon: number;
  names: Map<string, string>;
  activeDomain: string | null;
  checking: Set<string>;
  overrides: Map<string, JobItem>;
  watchIndex: WatchIndex;
  buyFor: string | null;
  onBuyFor: (domain: string | null) => void;
  actions: ResultActions;
  selection: ListSelection;
  onSelection: (next: ListSelection) => void;
  poll: boolean;
  bottomInset: number;
  /** Suffixes seen in loaded rows, so the page can fetch their published prices. */
  onSuffixes?: (suffixes: string[]) => void;
}

const iconButton =
  'grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground [&_svg]:size-4';

/**
 * A large search triaged into what can be registered (cheapest first), what is taken and what could
 * not be checked. Each section pages from the backend as it scrolls; taken names start collapsed.
 */
export function ResultList(props: ListProps) {
  const { job, savedListId, filters, prices, currency, horizon, names, activeDomain, checking, overrides, watchIndex, buyFor, onBuyFor, actions, selection, onSelection, poll, bottomInset, onSuffixes } = props;
  const counts = groupCounts(job);
  const free = useSectionResults(job.id, sectionFilter('free', filters, currency), poll);
  const taken = useSectionResults(job.id, sectionFilter('taken', filters, currency), poll);
  const problem = useSectionResults(job.id, sectionFilter('problem', filters, currency), poll);
  const pending = useSectionResults(job.id, sectionFilter('pending', filters, currency), poll);
  const sections = { free, taken, problem, pending };
  const [collapsed, setCollapsed] = useState<Record<RegistryGroup, boolean>>(() => ({ free: false, taken: counts.free > 0, problem: false, pending: false }));

  const groups: RegistryGroup[] = (['free', 'taken', 'problem', ...(counts.pending > 0 || (pending.total ?? 0) > 0 ? (['pending'] as const) : [])] as RegistryGroup[]).filter((g) =>
    groupAllowed(g, filters),
  );
  const totalOf = (group: RegistryGroup) => sections[group].total ?? counts[group];

  const groupKey = groups.join();
  const entries = useMemo(() => {
    const list: Entry[] = [];
    for (const group of groups) {
      list.push({ kind: 'header', group });
      if (collapsed[group]) continue;
      const section = sections[group];
      if (section.isError && section.items.length === 0) {
        list.push({ kind: 'error', group });
        continue;
      }
      if (section.isPending) {
        list.push({ kind: 'more', group });
        continue;
      }
      if (section.items.length === 0) {
        if ((section.total ?? 0) === 0) list.push({ kind: 'empty', group });
        continue;
      }
      for (const item of section.items) list.push({ kind: 'row', group, item: withOverride(item, overrides) });
      // A failed next page stops loading until retried instead of retrying on every scroll.
      if (section.isFetchNextPageError) list.push({ kind: 'error', group });
      else if (section.hasNextPage) list.push({ kind: 'more', group });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    groupKey,
    collapsed,
    free.items,
    taken.items,
    problem.items,
    pending.items,
    free.hasNextPage,
    taken.hasNextPage,
    problem.hasNextPage,
    pending.hasNextPage,
    free.isPending,
    taken.isPending,
    problem.isPending,
    pending.isPending,
    free.isError,
    taken.isError,
    problem.isError,
    pending.isError,
    free.isFetchNextPageError,
    taken.isFetchNextPageError,
    problem.isFetchNextPageError,
    pending.isFetchNextPageError,
    free.total,
    overrides,
  ]);

  // Prices are fetched per suffix by the page; report suffixes that only the list has loaded.
  const loadedSuffixes = [...new Set([...free.items, ...taken.items, ...problem.items, ...pending.items].map((i) => i.suffix).filter((x): x is string => Boolean(x)))].sort().join(',');
  useEffect(() => {
    if (loadedSuffixes) onSuffixes?.(loadedSuffixes.split(','));
  }, [loadedSuffixes, onSuffixes]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // React Compiler is not enabled; TanStack Virtual is used as documented.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (entries[index]?.kind === 'header' ? HEADER : ROW),
    overscan: 12,
    paddingEnd: bottomInset,
  });
  const virtualItems = virtualizer.getVirtualItems();

  // A visible "more" row loads that section's next page.
  useEffect(() => {
    for (const v of virtualItems) {
      const entry = entries[v.index];
      if (entry?.kind !== 'more') continue;
      const section = sections[entry.group];
      if (section.hasNextPage && !section.isFetchingNextPage) void section.fetchNextPage();
    }
  });

  const pendingFocus = useRef<number | null>(null);
  const focusEntry = (from: number, step: 1 | -1) => {
    let index = (pendingFocus.current ?? from) + step;
    while (index >= 0 && index < entries.length && entries[index]!.kind !== 'row') index += step;
    if (index < 0 || index >= entries.length) return;
    pendingFocus.current = index;
    virtualizer.scrollToIndex(index, { align: 'auto' });
    let tries = 0;
    const attempt = () => {
      if (pendingFocus.current !== index) return;
      const target = scrollRef.current?.querySelector<HTMLElement>(`[data-entry="${index}"] [data-row-focus]`);
      if (target) {
        target.focus({ preventScroll: true });
        pendingFocus.current = null;
      } else if (tries++ < 10) requestAnimationFrame(attempt);
      else pendingFocus.current = null;
    };
    requestAnimationFrame(attempt);
  };

  const toggleSelect = (item: JobItem, on: boolean) => {
    const next = new Map(selection);
    if (on) next.set(item.id, item);
    else next.delete(item.id);
    onSelection(next);
  };
  const selectGroup = (group: RegistryGroup, on: boolean) => {
    const next = new Map(selection);
    for (const item of sections[group].items) {
      if (on) next.set(item.id, item);
      else next.delete(item.id);
    }
    onSelection(next);
  };
  const [resolving, setResolving] = useState<RegistryGroup | null>(null);
  const selectAllInGroup = async (group: RegistryGroup) => {
    setResolving(group);
    try {
      const items = await resolveSection(job.id, sectionFilter(group, filters, currency));
      const next = new Map(selection);
      for (const item of items) next.set(item.id, item);
      onSelection(next);
    } finally {
      setResolving(null);
    }
  };

  const headerRow = (group: RegistryGroup) => {
    const section = sections[group];
    const total = totalOf(group);
    const loaded = section.items;
    const all = loaded.length > 0 && loaded.every((i) => selection.has(i.id));
    const some = loaded.some((i) => selection.has(i.id));
    return (
      <div className="flex h-full items-end pb-1.5" data-testid={`section-${group}`}>
        <div className="flex w-full items-center gap-2 px-1">
          <span className="flex w-6 justify-center">
            {!collapsed[group] && loaded.length ? (
              <Checkbox aria-label={`Select loaded ${GROUP_LABEL[group]} rows`} checked={all ? true : some ? 'indeterminate' : false} onCheckedChange={(v) => selectGroup(group, v === true)} />
            ) : null}
          </span>
          <button
            type="button"
            aria-expanded={!collapsed[group]}
            onClick={() => setCollapsed((c) => ({ ...c, [group]: !c[group] }))}
            className="flex items-center gap-1.5 rounded-sm text-sm font-semibold"
          >
            <ChevronRight aria-hidden className={cn('size-4 text-muted-foreground transition-transform', !collapsed[group] && 'rotate-90')} />
            {GROUP_LABEL[group]}
            <span className="font-normal text-muted-foreground tabular">{formatCount(total)}</span>
          </button>
          {!collapsed[group] && all && total > loaded.length ? (
            <Button size="sm" variant="link" className="ml-2 text-xs text-muted-foreground" disabled={resolving === group} onClick={() => void selectAllInGroup(group)}>
              Select all {formatCount(total)}
            </Button>
          ) : null}

        </div>
      </div>
    );
  };

  return (
    <div ref={scrollRef} data-testid="results-scroll" className="@container relative -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
      <div role="table" aria-label="Results" className="text-sm">
        <div role="rowgroup" className="sticky top-0 z-10 bg-background">
          <div role="row" className={cn('grid h-8 items-center gap-x-3 px-1 text-xs font-medium text-muted-foreground', COLS)}>
            <span role="columnheader">
              <span className="sr-only">Select</span>
            </span>
            <span role="columnheader">Domain</span>
            <span role="columnheader">Status</span>
            <span role="columnheader" className={SHOW.price}>
              First year
            </span>
            <span role="columnheader" className={cn(SHOW.more, 'justify-end')}>
              Renews
            </span>
            <span role="columnheader" className={cn(SHOW.more, 'justify-end')}>
              {horizon} years
            </span>
            <span role="columnheader" className={SHOW.checked}>
              Checked
            </span>
            <span role="columnheader" className={SHOW.actions}>
              <span className="sr-only">Actions</span>
            </span>
          </div>
        </div>
        <div role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((v) => {
            const entry = entries[v.index]!;
            const style = { height: v.size, transform: `translateY(${v.start}px)` };
            if (entry.kind === 'header') {
              return (
                <div key={`h-${entry.group}`} role="row" className="absolute inset-x-0 top-0" style={style}>
                  <div role="cell" className="h-full">
                    {headerRow(entry.group)}
                  </div>
                </div>
              );
            }
            if (entry.kind === 'more') {
              return (
                <div key={`m-${entry.group}-${v.index}`} role="row" className="absolute inset-x-0 top-0 flex items-center px-10" style={style}>
                  <Skeleton className="h-4 w-56" />
                </div>
              );
            }
            if (entry.kind === 'error') {
              const section = sections[entry.group];
              return (
                <div key={`x-${entry.group}-${v.index}`} role="row" className="absolute inset-x-0 top-0 flex items-center gap-2 px-10 text-sm" style={style}>
                  <span className="text-muted-foreground">{errorMessage(section.error)}</span>
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void (section.isFetchNextPageError ? section.fetchNextPage() : section.refetch())}>
                    <RotateCw />
                    Retry
                  </Button>
                </div>
              );
            }
            if (entry.kind === 'empty') {
              return (
                <div key={`e-${entry.group}`} role="row" className="absolute inset-x-0 top-0 flex items-center px-10 text-sm text-muted-foreground" style={style}>
                  {filters.q || filters.suffixes?.length || filters.maxPrice || filters.maxLength ? 'None match these filters.' : 'None.'}
                </div>
              );
            }
            const item = entry.item;
            return (
              <ListRow
                key={item.id}
                index={v.index}
                style={style}
                item={item}
                prices={prices}
                currency={currency}
                horizon={horizon}
                names={names}
                active={activeDomain === item.subject}
                checking={checking.has(item.subject) || (poll && item.outcome === null)}
                watched={watchIndex.has(item.subject)}
                saved={savedListId !== null && item.collectionIds.includes(savedListId)}
                selected={selection.has(item.id)}
                selecting={selection.size > 0}
                onSelect={(on) => toggleSelect(item, on)}
                buyOpen={buyFor === item.subject}
                onBuyOpen={(open) => onBuyFor(open ? item.subject : null)}
                onMove={(step) => focusEntry(v.index, step)}
                actions={actions}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ListRow({
  index,
  style,
  item,
  prices,
  currency,
  horizon,
  names,
  active,
  checking,
  watched,
  saved,
  selected,
  selecting,
  onSelect,
  buyOpen,
  onBuyOpen,
  onMove,
  actions,
}: {
  index: number;
  style: React.CSSProperties;
  item: JobItem;
  prices: PricesBySuffix;
  currency: string;
  horizon: number;
  names: Map<string, string>;
  active: boolean;
  checking: boolean;
  watched: boolean;
  saved: boolean;
  selected: boolean;
  /** Any row is selected: checkboxes stay visible so a range is easy to extend. */
  selecting: boolean;
  onSelect: (on: boolean) => void;
  buyOpen: boolean;
  onBuyOpen: (open: boolean) => void;
  onMove: (step: 1 | -1) => void;
  actions: ResultActions;
}) {
  const focusRef = useRef<HTMLButtonElement>(null);
  const free = !checking && item.outcome === 'no_record';
  const taken = !checking && item.outcome === 'registered';
  const problem = !checking && item.outcome !== null && !free && !taken;
  const line = free ? rowPrice(item, prices, currency) : null;
  const note = checking ? null : rowNote(item, line);
  const checkedAt = item.evidence.registry?.checkedAt ?? item.finishedAt;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      onMove(event.key === 'ArrowDown' ? 1 : -1);
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
    } else if (key === 'x') {
      event.preventDefault();
      onSelect(!selected);
    }
  };

  return (
    <div
      role="row"
      aria-selected={selected}
      data-entry={index}
      data-testid="result-row"
      data-domain={item.subject}
      onClick={() => actions.open(item.subject)}
      className={cn(
        'group/row absolute inset-x-0 top-0 grid cursor-pointer items-center gap-x-3 rounded-md px-1 transition-colors',
        COLS,
        selected || active ? 'bg-selected' : 'hover:bg-hover',
      )}
      style={style}
    >
      <span role="cell" className="flex justify-center" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          aria-label={`Select ${item.unicode || item.subject}`}
          checked={selected}
          onCheckedChange={(v) => onSelect(v === true)}
          className={cn(!selected && !selecting && 'opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100')}
        />
      </span>
      <span role="cell" className="flex min-w-0">
        <button
          ref={focusRef}
          type="button"
          data-row-focus
          onKeyDown={onKeyDown}
          onClick={(event) => {
            event.stopPropagation();
            actions.open(item.subject);
          }}
          className={cn('flex min-w-0 max-w-full items-center rounded-sm text-left', free ? 'font-medium' : 'text-muted-foreground')}
        >
          <DomainName ascii={item.subject} unicode={item.unicode} />
        </button>
      </span>
      <span role="cell" className="flex min-w-0 text-muted-foreground">
        <ResultStatus item={item} checking={checking} />
      </span>
      <span role="cell" className={cn(SHOW.price, 'min-w-0 items-baseline gap-1.5')}>
        {line?.firstYear ? (
          <>
            <Money amount={line.firstYear} currency={line.currency} className="font-semibold" />
            {line.firstYearTerm > 1 ? <span className="text-[11px] text-muted-foreground">/{line.firstYearTerm} yr</span> : null}
            <span className="truncate text-xs text-muted-foreground">{line.providerName}</span>
          </>
        ) : note ? (
          <span className="truncate text-xs text-muted-foreground">{note}</span>
        ) : null}
      </span>
      <span role="cell" className={cn(SHOW.more, 'justify-end text-muted-foreground')}>
        {line ? <Money amount={line.renewal} currency={line.currency} /> : null}
        {line?.renewal && line.renewalTerm > 1 ? <span className="text-[11px]">&nbsp;/{line.renewalTerm} yr</span> : null}
      </span>
      <span role="cell" className={cn(SHOW.more, 'justify-end text-muted-foreground')}>
        {line ? <Money amount={line.horizonTotal} currency={line.currency} /> : null}
      </span>
      <span role="cell" className={cn(SHOW.checked, 'truncate text-xs text-muted-foreground')}>
        {checkedAt ? <RelativeTime iso={checkedAt} /> : null}
      </span>
      <span role="cell" className={cn(SHOW.actions, 'items-center justify-end gap-0.5')} onClick={(e) => e.stopPropagation()}>
        <span className={cn('flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100', (buyOpen || active) && 'opacity-100')}>
          {free ? (
            <BuyMenu
              domain={item.subject}
              suffix={item.suffix ?? ''}
              lines={item.suffix ? priceLines(item.subject, prices.get(item.suffix), [], horizon, names) : []}
              horizon={horizon}
              open={buyOpen}
              onOpenChange={onBuyOpen}
              returnFocus={() => focusRef.current}
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
          <button type="button" tabIndex={-1} aria-label={`Details for ${item.subject}`} onClick={() => actions.open(item.subject)} className={iconButton}>
            <PanelRight />
          </button>
        </span>
        <button
          type="button"
          tabIndex={-1}
          aria-label={saved ? `Unsave ${item.subject}` : `Save ${item.subject}`}
          aria-pressed={saved}
          onClick={() => actions.toggleSave(item)}
          className={cn(iconButton, !saved && 'opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100')}
        >
          <Bookmark className={cn(saved && 'fill-current text-foreground')} />
        </button>
      </span>
    </div>
  );
}
