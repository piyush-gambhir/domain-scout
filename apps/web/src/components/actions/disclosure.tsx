import { Send } from 'lucide-react';

/** States exactly where names will be sent before an external request is submitted. */
export function Disclosure({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-5 flex gap-2 rounded-md bg-input px-3 py-2.5 text-sm" data-testid="disclosure">
      <Send aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>{children}</span>
    </p>
  );
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
