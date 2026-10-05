'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { readStorage, writeStorage } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { Button } from './button';

const WIDTH_KEY = 'ds.dock.width';
/** Matches --spacing-dock. */
const DEFAULT_WIDTH = 448;
const MIN_WIDTH = 360;
const MAX_WIDTH = 720;
/** Space the table beside the dock keeps when the window is narrow. */
const KEEP_FOR_CONTENT = 420;
const STEP = 16;

function storedWidth(): number {
  const value = Number(readStorage('local', WIDTH_KEY));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_WIDTH;
}

/** Largest width that still leaves room for the content beside the dock. */
function maxWidth(): number {
  const sidebar = document.querySelector<HTMLElement>('[data-testid="sidebar"]')?.offsetWidth ?? 0;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - sidebar - KEEP_FOR_CONTENT));
}

function isEditable(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/**
 * Detail pane docked to the right edge of the page. It takes its width from the content beside it
 * instead of covering it, so the table stays visible and usable: opening another row swaps the
 * content. The left edge is a splitter (drag, or arrow keys when focused); the width is remembered
 * per browser. Escape closes it unless a menu, dialog or text field has the key.
 */
export function Dock({
  label,
  header,
  actions,
  onClose,
  children,
  className,
}: {
  /** Accessible name of the pane. */
  label: string;
  header: React.ReactNode;
  actions?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(storedWidth);
  const [limit, setLimit] = useState(MAX_WIDTH);
  const shown = Math.min(Math.max(width, MIN_WIDTH), limit);

  useEffect(() => {
    const measure = () => setLimit(maxWidth());
    measure();
    window.addEventListener('resize', measure);
    // The sidebar collapsing or expanding (Cmd/Ctrl+B) changes the room left for the table.
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    const observer = sidebar ? new ResizeObserver(measure) : null;
    if (sidebar) observer?.observe(sidebar);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, []);

  const commit = useCallback((next: number) => {
    const clamped = Math.round(Math.min(Math.max(next, MIN_WIDTH), maxWidth()));
    setWidth(clamped);
    writeStorage('local', WIDTH_KEY, String(clamped));
  }, []);

  // Remember the last focused element on the page outside the pane (the row that opened it) and
  // return focus there when the pane closes while it holds focus. Dialogs and menus render in portals
  // outside <main>, so focus moving into them (e.g. Quote opened from the pane) is not an opener.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const pane = ref.current;
    const isOpener = (element: Element | null): element is HTMLElement =>
      element instanceof HTMLElement && !pane?.contains(element) && Boolean(document.querySelector('main')?.contains(element));
    if (isOpener(document.activeElement)) opener.current = document.activeElement;
    const onFocusIn = (event: FocusEvent) => {
      if (isOpener(event.target as Element | null)) opener.current = event.target as HTMLElement;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      const active = document.activeElement;
      if ((active === document.body || pane?.contains(active)) && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Radix layers (menus, dialogs, popovers) handle Escape first and mark it handled.
      if (event.key !== 'Escape' || event.defaultPrevented || isEditable(event.target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = shown;
    const onMove = (move: PointerEvent) => setWidth(Math.min(Math.max(startWidth + startX - move.clientX, MIN_WIDTH), maxWidth()));
    const onUp = (up: PointerEvent) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      commit(startWidth + startX - up.clientX);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  };

  return (
    <aside
      ref={ref}
      aria-label={label}
      style={{ width: shown }}
      className={cn(
        // A soft tint separates the pane; controls inside step one shade darker to stay visible on it.
        'relative flex min-h-0 shrink-0 flex-col bg-sidebar [--hover:var(--sidebar-hover)] [--input:var(--sidebar-hover)] [--selected:var(--sidebar-active)]',
        className,
      )}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={limit}
        aria-valuenow={shown}
        tabIndex={0}
        onPointerDown={startDrag}
        onDoubleClick={() => commit(DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          const delta = event.key === 'ArrowLeft' ? STEP : event.key === 'ArrowRight' ? -STEP : 0;
          if (delta) {
            event.preventDefault();
            commit(shown + delta);
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            commit(event.key === 'Home' ? MIN_WIDTH : maxWidth());
          }
        }}
        className="group absolute inset-y-0 -left-1.5 z-10 flex w-3 cursor-col-resize justify-center outline-none"
      >
        <span aria-hidden className="h-full w-0.5 rounded-full transition-colors group-hover:bg-control group-focus-visible:bg-ring" />
      </div>
      <div className="flex shrink-0 items-start justify-between gap-2 px-4 pt-3">
        <div className="min-w-0 flex-1">{header}</div>
        <div className="flex shrink-0 items-center gap-0.5">
          {actions}
          <Button variant="quiet" size="icon-sm" aria-label="Close panel" onClick={onClose}>
            <X />
          </Button>
        </div>
      </div>
      {children}
    </aside>
  );
}
