'use client';

import { DropdownMenu as Menu } from 'radix-ui';
import { Check, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;
export const DropdownMenuRadioGroup = Menu.RadioGroup;
export const DropdownMenuSub = Menu.Sub;

const itemClass =
  'relative flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-hover data-[disabled]:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0';

export function DropdownMenuContent({ className, sideOffset = 6, align = 'end', ...props }: React.ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={sideOffset}
        align={align}
        className={cn('anim-fade z-50 min-w-44 rounded-lg bg-popover p-1 shadow-xl outline-none', className)}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof Menu.Item>) {
  return <Menu.Item className={cn(itemClass, className)} {...props} />;
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof Menu.Label>) {
  return <Menu.Label className={cn('px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground', className)} {...props} />;
}

export function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof Menu.RadioItem>) {
  return (
    <Menu.RadioItem className={cn(itemClass, 'pr-8', className)} {...props}>
      {children}
      <Menu.ItemIndicator className="absolute right-2">
        <Check />
      </Menu.ItemIndicator>
    </Menu.RadioItem>
  );
}

export function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem className={cn(itemClass, 'pr-8', className)} {...props}>
      {children}
      <Menu.ItemIndicator className="absolute right-2">
        <Check />
      </Menu.ItemIndicator>
    </Menu.CheckboxItem>
  );
}

/** Vertical space between groups; no divider lines. */
export function DropdownMenuGap() {
  return <div aria-hidden className="h-1" />;
}

export function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof Menu.SubTrigger>) {
  return (
    <Menu.SubTrigger className={cn(itemClass, 'data-[state=open]:bg-hover', className)} {...props}>
      {children}
      <ChevronRight className="ml-auto text-muted-foreground" />
    </Menu.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof Menu.SubContent>) {
  return (
    <Menu.Portal>
      <Menu.SubContent
        sideOffset={4}
        className={cn('anim-fade z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-48 overflow-y-auto rounded-lg bg-popover p-1 shadow-xl outline-none', className)}
        {...props}
      />
    </Menu.Portal>
  );
}
