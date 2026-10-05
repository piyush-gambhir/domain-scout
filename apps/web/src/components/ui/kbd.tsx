import { cn } from '@/lib/utils';

export function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded bg-input px-1.5 font-mono text-[11px] text-muted-foreground', className)}
      {...props}
    />
  );
}
