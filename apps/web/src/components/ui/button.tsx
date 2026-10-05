import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/85',
        secondary: 'bg-input text-foreground hover:bg-selected',
        ghost: 'text-foreground hover:bg-hover',
        quiet: 'text-muted-foreground hover:bg-hover hover:text-foreground',
        danger: 'bg-negative/10 text-negative hover:bg-negative/15',
        link: 'h-auto rounded-sm px-0 text-foreground underline-offset-4 hover:underline',
      },
      // Every size keeps the 32px minimum hit target (--spacing-control).
      size: {
        sm: 'h-control px-2.5',
        md: 'h-control px-3',
        lg: 'h-9 px-4',
        icon: 'size-control',
        'icon-sm': 'size-control',
        'icon-xs': 'size-control [&_svg]:size-3.5',
      },
    },
    // A link-styled button keeps the text's own box whatever size it is given.
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  if (asChild) return <Slot.Root className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  return <button type={type ?? 'button'} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
