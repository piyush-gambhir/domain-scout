import type { OperationResponse } from '@domain-scout/contracts';
import { formatCount } from './format';

type HistoryEntry = OperationResponse<'listHistory'>['data'][number];

/** Origins of work a person started: the web UI and agents through the CLI. */
export const PEOPLE_ORIGINS = 'ui,cli';

/** "12 not registered of 40" for a finished search; progress while it runs. */
export function searchSummary(entry: Pick<HistoryEntry, 'state' | 'type' | 'total' | 'finished' | 'outcomes'>): string {
  if (entry.state === 'queued' || entry.state === 'running' || entry.state === 'cancelling') return `Checking ${formatCount(entry.finished)} of ${formatCount(entry.total)}`;
  if (entry.type !== 'registry_scan' && entry.type !== 'watch') return `${formatCount(entry.total)} items`;
  const free = entry.outcomes.no_record ?? 0;
  return `${formatCount(free)} not registered of ${formatCount(entry.total)}`;
}
