import type { OperationResponse } from '@domain-scout/contracts';
import { formatCount } from './format';

type HistoryEntry = OperationResponse<'listHistory'>['data'][number];





export const PEOPLE_ORIGINS = 'ui,cli,api';


export function searchSummary(entry: Pick<HistoryEntry, 'state' | 'type' | 'total' | 'finished' | 'outcomes'>): string {
  if (entry.state === 'queued' || entry.state === 'running' || entry.state === 'cancelling') return `Checking ${formatCount(entry.finished)} of ${formatCount(entry.total)}`;
  if (entry.type !== 'registry_scan' && entry.type !== 'watch') return `${formatCount(entry.total)} items`;
  const free = entry.outcomes.no_record ?? 0;
  return `${formatCount(free)} not registered of ${formatCount(entry.total)}`;
}
