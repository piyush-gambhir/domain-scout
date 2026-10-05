'use client';

import { RotateCw } from 'lucide-react';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn('flex flex-col items-start gap-2 rounded-lg bg-negative/5 px-3 py-2.5 text-sm', className)}>
      <p className="text-foreground">{errorMessage(error)}</p>
      {onRetry ? (
        <Button size="sm" variant="ghost" onClick={onRetry} className="-ml-2">
          <RotateCw />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** One short line, centered in whatever pane holds it. */
export function EmptyState({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn('flex flex-1 items-center justify-center py-8 text-center text-sm text-muted-foreground', className)}>{children}</p>;
}

/**
 * A page inside the app frame: a column that fills <main>. At lg and up it never grows past the
 * window; its panes divide the height and only growing data scrolls. Below lg it takes its natural
 * height and the document scrolls.
 */
export function Page({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex min-w-0 flex-1 flex-col gap-section px-4 pb-6 pt-3 md:px-gutter lg:min-h-0 lg:pb-4', className)} {...props} />;
}

/**
 * Compact page header: the title with short key facts inline (`meta`) and the primary actions on the
 * right. `children` is a second line across the full width for counts and secondary metadata; it
 * wraps there instead of squeezing beside the actions.
 */
export function PageHeader({
  title,
  leading,
  meta,
  actions,
  children,
}: {
  title: React.ReactNode;
  /** Before the title, e.g. the parent page as a breadcrumb or a back button. */
  leading?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="grid shrink-0 grid-cols-1 items-start gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-h-control min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-0 max-w-full items-center gap-2">
          {leading}
          <h1 className={cn('min-w-0 text-base font-semibold tracking-tight', typeof title === 'string' && 'truncate')}>{title}</h1>
        </div>
        {meta ? <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1 text-sm">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">{actions}</div> : null}
      {children ? <div className="col-span-full flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{children}</div> : null}
    </header>
  );
}

/** Muted parent-page link shown before a title, with a slash after it. */
export function Crumb({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-2 text-base text-muted-foreground">
      {children}
      <span aria-hidden>/</span>
    </span>
  );
}

/**
 * A pane that fills the rest of its column at lg and scrolls inside itself; natural height below lg.
 * The 4px inset keeps focus rings of edge-aligned controls inside the scrollport. Every scroll pane is
 * positioned so absolutely positioned descendants (sr-only text) stay inside it instead of
 * stretching an outer box.
 */
export function ScrollPane({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('relative -mx-1 px-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto', className)} {...props} />;
}

/** Section heading inside a page or panel. */
export function SectionTitle({ children, className, id }: { children: React.ReactNode; className?: string; id?: string }) {
  return (
    <h2 id={id} className={cn('mb-2 text-sm font-semibold', className)}>
      {children}
    </h2>
  );
}

/** Two-column definition list with muted terms. */
export function Facts({ items, className }: { items: [React.ReactNode, React.ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm', className)}>
      {items.map(([term, value], index) => (
        <div key={index} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Inline label and number, for counts that sit in a header or toolbar line. */
export function InlineStat({ label, value, testId, emphasis }: { label: string; value: React.ReactNode; testId?: string; emphasis?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5 whitespace-nowrap">
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className={cn('font-mono tabular', emphasis && 'font-semibold')}>
        {value}
      </dd>
    </div>
  );
}
