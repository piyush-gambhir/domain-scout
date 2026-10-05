import type { StatusInfo, Tone } from '@/lib/labels';
import { cn } from '@/lib/utils';

const TONE_CLASS: Record<Tone, string> = {
  positive: 'text-positive',
  neutral: 'text-neutral',
  caution: 'text-caution',
  negative: 'text-negative',
  muted: 'text-muted-foreground',
};

/** Small dot; a ring for unresolved states so they never read as a positive filled dot. */
export function StatusDot({ tone, unresolved, className }: { tone: Tone; unresolved?: boolean; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 10 10" className={cn('size-2 shrink-0', TONE_CLASS[tone], className)}>
      {unresolved ? (
        <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="2" />
      ) : (
        <circle cx="5" cy="5" r="4.5" fill="currentColor" />
      )}
    </svg>
  );
}

/** Status color plus its text label, always together. */
export function StatusLabel({ status, className, textClassName }: { status: StatusInfo; className?: string; textClassName?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <StatusDot tone={status.tone} unresolved={status.unresolved} />
      <span className={cn('truncate', textClassName)}>{status.label}</span>
    </span>
  );
}

/** Colored text for short qualifiers such as Stale or Expired. */
export function ToneText({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cn(TONE_CLASS[tone], className)}>{children}</span>;
}
