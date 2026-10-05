'use client';

import { useEffect, useRef } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/** The element to return to: a menu item is replaced by the trigger of its (closing) menu. */
function openerOf(active: Element | null): HTMLElement | null {
  if (!(active instanceof HTMLElement)) return null;
  const menu = active.closest<HTMLElement>('[role="menu"]');
  if (menu?.id) {
    const trigger = document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`);
    if (trigger) return trigger;
  }
  return active;
}

const DIALOG = '[role="dialog"], [role="alertdialog"]';

/** Last element focused outside any dialog, tracked from the first dialog hook onward. */
let lastOutside: HTMLElement | null = null;
let tracking = false;
function trackFocus() {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener(
    'focusin',
    (event) => {
      if (event.target instanceof HTMLElement && !event.target.closest(DIALOG)) lastOutside = event.target;
    },
    true,
  );
}

/** Remembers what had focus when a dialog opened and returns focus there on close. Radix only
 * restores focus to a registered Trigger, and most dialogs here open from menus or toolbars. A
 * dialog whose field uses autoFocus skips Radix's open hook, so it falls back to the last element
 * focused outside any dialog. */
export function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  useEffect(trackFocus, []);
  return {
    onOpenAutoFocus: () => {
      const active = document.activeElement;
      opener.current = openerOf(active instanceof HTMLElement && !active.closest(DIALOG) ? active : lastOutside);
    },
    onCloseAutoFocus: (event: Event) => {
      const target = opener.current ?? openerOf(lastOutside);
      opener.current = null;
      if (target?.isConnected && !target.matches(':disabled')) {
        event.preventDefault();
        target.focus({ preventScroll: true });
      }
    },
  };
}

export function DialogContent({
  className,
  children,
  title,
  wide,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { title: React.ReactNode; wide?: boolean }) {
  const returnFocus = useReturnFocus();
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="anim-fade fixed inset-0 z-50 bg-overlay" />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          returnFocus.onOpenAutoFocus();
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (!event.defaultPrevented) returnFocus.onCloseAutoFocus(event);
        }}
        className={cn(
          'anim-pop fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-popover shadow-2xl outline-none',
          wide ? 'max-w-2xl' : 'max-w-lg',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <DialogPrimitive.Title className="text-base font-semibold leading-7">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close asChild>
            <Button variant="quiet" size="icon-sm" aria-label="Close" className="-mr-2">
              <X />
            </Button>
          </DialogPrimitive.Close>
        </div>
        <div className="relative min-h-0 overflow-y-auto px-6 pb-6 pt-4">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mt-6 flex flex-wrap items-center justify-end gap-2', className)} {...props} />;
}
