'use client';

import { useState } from 'react';
import type { JobItem } from '@domain-scout/contracts';

/**
 * Row selection for a filtered, paginated result set.
 * - `ids`: explicit rows.
 * - `all`: every row matching the current filter, minus explicit exclusions.
 * Changing the filter clears the selection so bulk actions never reach rows that are not shown.
 */
type Mode = { kind: 'ids'; items: Map<string, JobItem> } | { kind: 'all'; excluded: Set<string> };

export interface Selection {
  mode: 'ids' | 'all';
  isSelected: (id: string) => boolean;
  count: (total: number | null) => number;
  /** Selected rows among the loaded ones (ids mode) for labels; all mode uses count(). */
  explicitItems: JobItem[];
  excluded: Set<string>;
  toggle: (item: JobItem, index: number, range: boolean, rows: JobItem[]) => void;
  setLoaded: (rows: JobItem[], selected: boolean) => void;
  selectAllMatching: () => void;
  clear: () => void;
  isEmpty: (total: number | null) => boolean;
}

export function useSelection(filterKey: string): Selection {
  const [mode, setState] = useState<Mode>({ kind: 'ids', items: new Map() });
  const [anchor, setAnchor] = useState<number | null>(null);
  const [forFilter, setForFilter] = useState(filterKey);
  if (forFilter !== filterKey) {
    // Reset during render (derived state) rather than in an effect, so no stale frame acts on it.
    setForFilter(filterKey);
    setState({ kind: 'ids', items: new Map() });
    setAnchor(null);
  }

  const isSelected = (id: string) => (mode.kind === 'ids' ? mode.items.has(id) : !mode.excluded.has(id));

  const apply = (current: Mode, targets: JobItem[], selected: boolean): Mode => {
    if (current.kind === 'ids') {
      const items = new Map(current.items);
      for (const item of targets) {
        if (selected) items.set(item.id, item);
        else items.delete(item.id);
      }
      return { kind: 'ids', items };
    }
    const excluded = new Set(current.excluded);
    for (const item of targets) {
      if (selected) excluded.delete(item.id);
      else excluded.add(item.id);
    }
    return { ...current, excluded };
  };

  const toggle = (item: JobItem, index: number, range: boolean, rows: JobItem[]) => {
    const nextSelected = !isSelected(item.id);
    let targets = [item];
    if (range && anchor !== null && anchor < rows.length) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      targets = rows.slice(from, to + 1);
    }
    setAnchor(index);
    setState(apply(mode, targets, nextSelected));
  };

  return {
    mode: mode.kind,
    isSelected,
    count: (total) => (mode.kind === 'ids' ? mode.items.size : Math.max(0, (total ?? 0) - mode.excluded.size)),
    explicitItems: mode.kind === 'ids' ? [...mode.items.values()] : [],
    excluded: mode.kind === 'all' ? mode.excluded : new Set(),
    toggle,
    setLoaded: (rows, selected) => setState(apply(mode, rows, selected)),
    selectAllMatching: () => setState({ kind: 'all', excluded: new Set() }),
    clear: () => {
      setAnchor(null);
      setState({ kind: 'ids', items: new Map() });
    },
    isEmpty: (total) => (mode.kind === 'ids' ? mode.items.size === 0 : (total ?? 0) - mode.excluded.size <= 0),
  };
}
