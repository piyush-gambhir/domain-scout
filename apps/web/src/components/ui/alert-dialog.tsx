'use client';

import { AlertDialog as AlertPrimitive } from 'radix-ui';
import { Button } from './button';
import { useReturnFocus } from './dialog';

/** Confirmation for destructive actions only. Routine checks never ask for confirmation. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
}) {
  const returnFocus = useReturnFocus();
  return (
    <AlertPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay className="anim-fade fixed inset-0 z-50 bg-overlay" />
        <AlertPrimitive.Content
          className="anim-pop fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-popover p-6 shadow-2xl outline-none"
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={returnFocus.onOpenAutoFocus}
          onCloseAutoFocus={returnFocus.onCloseAutoFocus}
        >
          <AlertPrimitive.Title className="text-base font-semibold">{title}</AlertPrimitive.Title>
          {description ? (
            <AlertPrimitive.Description className="mt-2 text-sm text-muted-foreground">{description}</AlertPrimitive.Description>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <AlertPrimitive.Cancel asChild>
              <Button variant="ghost">Cancel</Button>
            </AlertPrimitive.Cancel>
            <Button variant="danger" disabled={pending} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  );
}
