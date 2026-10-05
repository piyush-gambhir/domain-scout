'use client';

import { useRef } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

/**
 * Right-side panel. Non-modal so the results table stays visible and usable: clicking another row
 * swaps the panel content instead of closing it. Escape or the close button dismisses it, and focus
 * returns to whatever opened it.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  actions,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          ref={content}
          aria-describedby={undefined}
          tabIndex={-1}
          onInteractOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            content.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
          }}
          className={cn(
            'anim-sheet fixed inset-y-0 right-0 z-40 flex w-full max-w-[36rem] flex-col bg-popover shadow-[0_0_48px_rgb(0_0_0/0.14)] outline-none dark:shadow-[0_0_48px_rgb(0_0_0/0.6)]',
            className,
          )}
        >
          <div className="flex items-center justify-between gap-3 px-6 pb-2 pt-4">
            <DialogPrimitive.Title className="min-w-0 truncate font-mono text-base font-semibold">{title}</DialogPrimitive.Title>
            <div className="flex shrink-0 items-center gap-1">
              {actions}
              <DialogPrimitive.Close asChild>
                <Button variant="quiet" size="icon-sm" aria-label="Close panel">
                  <X />
                </Button>
              </DialogPrimitive.Close>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
