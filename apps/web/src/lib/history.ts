'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Job } from '@domain-scout/contracts';
import { api } from './api';
import { formatCount } from './format';
import { qk } from './queries';

/** Origins of work a person started: the web UI and agents through the CLI. */
export const PEOPLE_ORIGINS = 'ui,cli';

/**
 * Recent jobs by id, for result summaries next to history entries (history rows carry totals, not
 * outcome counts). One request covers the recent page; older rows simply show their totals.
 */
export function useJobSummaries(origins: string | undefined, enabled = true) {
  const query = { ...(origins ? { origins } : {}), limit: 200 };
  const jobs = useQuery({
    queryKey: qk.jobSummaries(query),
    queryFn: ({ signal }) => api.call('listJobs', { query, signal }).then((r) => r.data),
    enabled,
    refetchInterval: (q) => (q.state.data?.some((job) => job.state === 'running' || job.state === 'queued') ? 4000 : false),
  });
  return useMemo(() => new Map((jobs.data ?? []).map((job) => [job.id, job])), [jobs.data]);
}

/** "12 not registered of 40" for a finished search; progress while it runs. */
export function searchSummary(job: Pick<Job, 'state' | 'counters' | 'type'>): string {
  const { counters } = job;
  if (job.state === 'queued' || job.state === 'running' || job.state === 'cancelling') return `Checking ${formatCount(counters.finished)} of ${formatCount(counters.total)}`;
  if (job.type !== 'registry_scan' && job.type !== 'watch') return `${formatCount(counters.total)} items`;
  const free = counters.outcomes.no_record ?? 0;
  return `${formatCount(free)} not registered of ${formatCount(counters.total)}`;
}
