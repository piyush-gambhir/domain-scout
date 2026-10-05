'use client';

import { RadioGroup } from 'radix-ui';
import { cn } from '@/lib/utils';

/** Single choice shown as a segmented control. Arrow keys move between options. */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  className,
  'aria-label': ariaLabel,
  size = 'md',
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: { value: T; label: React.ReactNode; disabled?: boolean }[];
  className?: string;
  'aria-label': string;
  size?: 'sm' | 'md';
}) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
      aria-label={ariaLabel}
      orientation="horizontal"
      className={cn('inline-flex max-w-full flex-wrap rounded-md bg-input p-0.5', className)}
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={cn(
            'rounded-[5px] px-3 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-45 data-[state=checked]:bg-background data-[state=checked]:font-medium data-[state=checked]:text-foreground data-[state=checked]:shadow-sm',
            size === 'sm' ? 'h-7' : 'h-8',
          )}
        >
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
