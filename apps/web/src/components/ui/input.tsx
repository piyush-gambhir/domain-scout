import { cn } from '@/lib/utils';

export const fieldClass =
  'w-full min-w-0 rounded-md bg-input text-sm text-foreground placeholder:text-muted-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:bg-negative/10';

export function Input({ className, type = 'text', ...props }: React.ComponentProps<'input'>) {
  return <input type={type} className={cn(fieldClass, 'h-9 px-3', className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldClass, 'min-h-24 resize-y px-3 py-2 leading-relaxed', className)} {...props} />;
}
