'use client';

import { RotateCw } from 'lucide-react';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cn('flex flex-col items-start gap-3 rounded-lg bg-negative/5 px-4 py-3 text-sm', className)}>
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

export function EmptyState({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn('py-10 text-center text-sm text-muted-foreground', className)}>{children}</p>;
}

export function PageHeader({ title, actions, children }: { title: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h1 className="min-w-0 text-xl font-semibold tracking-tight">{title}</h1>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

/** Section heading inside a page or panel. */
export function SectionTitle({ children, className, id }: { children: React.ReactNode; className?: string; id?: string }) {
  return (
    <h2 id={id} className={cn('mb-3 text-sm font-semibold', className)}>
      {children}
    </h2>
  );
}

/** Two-column definition list with muted terms. */
export function Facts({ items, className }: { items: [React.ReactNode, React.ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-6 gap-y-2 text-sm', className)}>
      {items.map(([term, value], index) => (
        <div key={index} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
