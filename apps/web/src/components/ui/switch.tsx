import { Switch as SwitchPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-control p-0.5 transition-colors hover:bg-control-hover disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:bg-primary',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4 rounded-full bg-background shadow-sm transition-transform data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  );
}

/** Switch with a clickable text label on the left. */
export function SwitchField({
  id,
  label,
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & { id: string; label: React.ReactNode }) {
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <Switch id={id} {...props} />
    </div>
  );
}
