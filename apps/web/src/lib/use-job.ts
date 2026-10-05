'use client';

import { useQuery } from '@tanstack/react-query';
import { TERMINAL_JOB_STATES, type Job } from '@domain-scout/contracts';
import { api } from './api';
import { useJobEvents } from './events';
import { qk } from './queries';

export function isTerminal(job: Pick<Job, 'state'> | undefined | null): boolean {
  return Boolean(job && TERMINAL_JOB_STATES.includes(job.state));
}

/** A job kept current by SSE, polling every 2 s while the stream is down and the job is active. */
export function useLiveJob(jobId: string | null | undefined) {
  const { live } = useJobEvents(jobId);
  const query = useQuery({
    queryKey: qk.job(jobId ?? ''),
    queryFn: ({ signal }) => api.call('getJob', { params: { id: jobId! }, signal }).then((r) => r.data),
    enabled: Boolean(jobId),
    refetchInterval: (q) => (!live && q.state.data && !isTerminal(q.state.data) ? 2000 : false),
  });
  return { ...query, live };
}
