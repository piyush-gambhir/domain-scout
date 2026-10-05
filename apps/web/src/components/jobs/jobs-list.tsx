'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { JobState, JobType } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { JOB_STATE, JOB_TYPE, jobStateStatus, jobTypeLabel } from '@/lib/labels';
import { formatCount } from '@/lib/format';
import { qk } from '@/lib/queries';
import { RelativeTime } from '../domain/time';
import { EmptyState, ErrorState, PageHeader } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import { SkeletonRows } from '../ui/skeleton';

const ANY = '__any__';

export function JobsList() {
  const [type, setType] = useState<string>(ANY);
  const [state, setState] = useState<string>(ANY);
  const query = { type: type === ANY ? undefined : (type as JobType), state: state === ANY ? undefined : (state as JobState) };
  const jobs = useInfiniteQuery({
    queryKey: qk.jobs(query),
    queryFn: ({ pageParam, signal }) => api.call('listJobs', { query: { ...query, cursor: pageParam, limit: 50 }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (q) =>
      q.state.data?.pages.some((page) => page.data.some((job) => job.state === 'running' || job.state === 'queued' || job.state === 'cancelling'))
        ? 4000
        : false,
  });
  const rows = jobs.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <>
      <PageHeader
        title="Jobs"
        actions={
          <>
            <Select
              aria-label="Type"
              value={type}
              onValueChange={setType}
              className="w-44"
              options={[{ value: ANY, label: 'All types' }, ...Object.entries(JOB_TYPE).map(([value, label]) => ({ value, label }))]}
            />
            <Select
              aria-label="State"
              value={state}
              onValueChange={setState}
              className="w-48"
              options={[{ value: ANY, label: 'All states' }, ...Object.entries(JOB_STATE).map(([value, info]) => ({ value, label: info.label }))]}
            />
          </>
        }
      />
      {jobs.isPending ? (
        <SkeletonRows rows={8} />
      ) : jobs.isError ? (
        <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState>No jobs yet.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-0.5" aria-label="Jobs">
          {rows.map((job) => {
            const { counters } = job;
            const percent = counters.total ? (counters.finished / counters.total) * 100 : 0;
            return (
              <li key={job.id}>
                <Link
                  href={`/jobs/${job.id}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 rounded-lg px-3 py-3 transition-colors hover:bg-hover sm:grid-cols-[minmax(0,1fr)_12rem_11rem_6rem]"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{job.label ?? jobTypeLabel(job.type)}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {job.label ? `${jobTypeLabel(job.type)} · ` : ''}
                      <RelativeTime iso={job.createdAt} />
                      {job.input.extensions.length ? <span className="font-mono"> · {job.input.extensions.map((e) => `.${e}`).join(' ')}</span> : null}
                    </span>
                  </span>
                  <span className="hidden flex-col gap-1.5 sm:flex">
                    <span className="h-1 w-full overflow-hidden rounded-full bg-input" aria-hidden>
                      <span className="block h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                    </span>
                    <span className="font-mono text-xs text-muted-foreground tabular">
                      {formatCount(counters.finished)} / {formatCount(counters.total)}
                    </span>
                  </span>
                  <StatusLabel status={jobStateStatus(job.state)} className="justify-self-end text-sm sm:justify-self-start" />
                  <span className="hidden text-right font-mono text-xs text-muted-foreground tabular sm:block">
                    {counters.unresolved ? `${formatCount(counters.unresolved)} unresolved` : ''}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {jobs.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <Button variant="ghost" disabled={jobs.isFetchingNextPage} onClick={() => jobs.fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}
