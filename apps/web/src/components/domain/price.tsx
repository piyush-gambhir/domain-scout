import type { PriceKind } from '@domain-scout/contracts';
import { PRICE_KIND } from '@/lib/labels';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Amount (mono) with its price kind; null amounts read "Unknown", never zero. */
export function Price({
  amount,
  currency,
  kind,
  years,
  className,
}: {
  amount: string | null | undefined;
  currency: string | null | undefined;
  kind?: PriceKind | null;
  years?: number | null;
  className?: string;
}) {
  if (amount === null || amount === undefined) return <span className={cn('text-muted-foreground', className)}>Unknown</span>;
  return (
    <span className={cn('inline-flex min-w-0 items-baseline gap-1.5', className)}>
      <span className="font-mono tabular">{formatMoney(amount, currency)}</span>
      {years && years > 1 ? <span className="text-xs text-muted-foreground">/{years} yr</span> : null}
      {kind ? <span className="truncate text-xs text-muted-foreground">{PRICE_KIND[kind]}</span> : null}
    </span>
  );
}
