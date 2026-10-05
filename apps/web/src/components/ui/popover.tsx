'use client';

import { Popover as PopoverPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({ className, align = 'start', sideOffset = 6, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn('anim-fade z-50 max-h-[var(--radix-popover-content-available-height)] min-w-56 overflow-y-auto rounded-lg bg-popover p-2 shadow-xl outline-none', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
