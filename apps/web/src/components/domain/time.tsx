'use client';

import type { Freshness as FreshnessValue } from '@domain-scout/contracts';
import { FRESHNESS } from '@/lib/labels';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { ToneText } from '../status';

export function RelativeTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const now = useNow();
  if (!iso) return <span className={className}>Unknown</span>;
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className}>
      {formatRelative(iso, now)}
    </time>
  );
}





export function useFreshness(
  freshness: FreshnessValue | null | undefined,
  staleAt: string | null | undefined,
  expiresAt?: string | null,
): FreshnessValue | null {
  const now = useNow();
  if (!freshness) return null;
  if (freshness === 'expired' || (expiresAt && new Date(expiresAt).getTime() <= now)) return 'expired';
  if (staleAt && new Date(staleAt).getTime() <= now) return 'stale';
  return freshness;
}

export function FreshnessText({
  freshness,
  staleAt,
  hideFresh,
  className,
}: {
  freshness: FreshnessValue | null | undefined;
  staleAt?: string | null;
  hideFresh?: boolean;
  className?: string;
}) {
  const value = useFreshness(freshness, staleAt);
  if (!value || (hideFresh && value === 'fresh')) return null;
  const info = FRESHNESS[value];
  return (
    <ToneText tone={info.tone} className={className}>
      {info.label}
    </ToneText>
  );
}


export function CheckedAt({
  iso,
  freshness,
  staleAt,
  expiresAt,
  className,
}: {
  iso: string | null | undefined;
  freshness?: FreshnessValue | null;
  staleAt?: string | null;

  expiresAt?: string | null;
  className?: string;
}) {
  const value = useFreshness(freshness ?? null, staleAt, expiresAt);
  return (
    <span className={className}>
      <RelativeTime iso={iso} />
      {value && value !== 'fresh' ? (
        <>
          <span className="text-muted-foreground"> · </span>
          <FreshnessText freshness={value} />
        </>
      ) : null}
    </span>
  );
}
