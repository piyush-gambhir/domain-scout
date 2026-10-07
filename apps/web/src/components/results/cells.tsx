'use client';

import type { JobItem } from '@domain-scout/contracts';
import { NOT_REGISTERED_HINT, type StatusInfo, outcomeStatus } from '@/lib/labels';
import { formatDate, formatMoney } from '@/lib/format';
import type { PriceLine } from '@/lib/prices';
import { cn } from '@/lib/utils';
import { StatusLabel } from '../status';
import { Tooltip } from '../ui/tooltip';

export const CHECKING: StatusInfo = { label: 'Checking', tone: 'muted', unresolved: true };

export const NOT_CHECKED: StatusInfo = { label: 'Not checked', tone: 'caution', unresolved: true };

/** Pending rows read "Checking" while work runs (callers pass `checking`) and "Not checked" otherwise. */
export function itemStatus(item: JobItem, checking: boolean): StatusInfo {
  if (checking) return CHECKING;
  if (item.outcome === null) return NOT_CHECKED;
  return outcomeStatus('registry', item.outcome, item.state);
}

/** Why a row could not be checked: the registry's reason, else the grouped detail. */
export function problemReason(item: JobItem): string | null {
  const status = outcomeStatus('registry', item.outcome, item.state);
  return item.error?.message ?? item.evidence.registry?.reason.message ?? status.detail ?? null;
}

export function expiryOf(item: JobItem): string | null {
  return item.evidence.registry?.registration?.expiresAt ?? null;
}

/** Status with its label; "Not registered" carries the hint that a provider should confirm it. */
export function ResultStatus({ item, checking, className }: { item: JobItem; checking?: boolean; className?: string }) {
  const status = itemStatus(item, Boolean(checking));
  const label = <StatusLabel status={status} className={className} />;
  if (!checking && item.outcome === 'no_record') {
    return (
      <Tooltip content={NOT_REGISTERED_HINT}>
        <span className="inline-flex min-w-0">{label}</span>
      </Tooltip>
    );
  }
  return label;
}

export function Money({ amount, currency, className }: { amount: string | null | undefined; currency: string; className?: string }) {
  if (amount === null || amount === undefined) return <span className={cn('text-muted-foreground', className)}>Unknown</span>;
  return <span className={cn('tabular', className)}>{formatMoney(amount, currency)}</span>;
}

/** Second line of a row or cell: price for a free name, expiry for a taken one, the reason otherwise. */
export function rowNote(item: JobItem, line: PriceLine | null): string | null {
  if (item.outcome === 'registered') {
    const expires = expiryOf(item);
    return expires ? `Expires ${formatDate(expires)}` : null;
  }
  if (item.outcome === 'no_record') return line?.firstYear ? null : 'No price known';
  return problemReason(item);
}
