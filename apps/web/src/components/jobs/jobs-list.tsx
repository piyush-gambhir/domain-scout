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
import { EmptyState, ErrorState, Page, PageHeader, ScrollPane } from '../states';
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

  const total = jobs.data?.pages[0]?.total ?? null;

  return (
    <Page>
      <PageHeader
        title="Jobs"
        meta={total !== null ? <span className="font-mono text-muted-foreground tabular">{formatCount(total)}</span> : null}
        actions={
          <>
            <Select
              aria-label="Type"
              value={type}
              onValueChange={setType}
              className="w-40"
              options={[{ value: ANY, label: 'All types' }, ...Object.entries(JOB_TYPE).map(([value, label]) => ({ value, label }))]}
            />
            <Select
              aria-label="State"
              value={state}
              onValueChange={setState}
              className="w-44"
              options={[{ value: ANY, label: 'All states' }, ...Object.entries(JOB_STATE).map(([value, info]) => ({ value, label: info.label }))]}
            />
          </>
        }
      />
      {jobs.isPending ? (
        <SkeletonRows rows={10} />
      ) : jobs.isError ? (
        <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState>{type !== ANY || state !== ANY ? 'No jobs match.' : 'No jobs yet.'}</EmptyState>
      ) : (
        <ScrollPane>
          <ul className="flex flex-col" aria-label="Jobs">
            {rows.map((job) => {
              const { counters } = job;
              const percent = counters.total ? (counters.finished / counters.total) * 100 : 0;
              return (
                <li key={job.id}>
                  <Link
                    href={`/jobs/${job.id}`}
                    className="focus-inset grid min-h-row grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 rounded-md px-2.5 py-1 transition-colors hover:bg-hover sm:grid-cols-[minmax(0,1fr)_10rem_11rem_7rem]"
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate font-medium">{job.label ?? jobTypeLabel(job.type)}</span>
                      <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">
                        {job.label ? `${jobTypeLabel(job.type)} · ` : ''}
                        <RelativeTime iso={job.createdAt} />
                        {job.input.extensions.length ? <span className="font-mono"> · {job.input.extensions.map((e) => `.${e}`).join(' ')}</span> : null}
                      </span>
                    </span>
                    <span className="hidden items-center gap-2 sm:flex">
                      <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-input" aria-hidden>
                        <span className="block h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                      </span>
                      <span className="truncate font-mono text-xs text-muted-foreground tabular">
                        {formatCount(counters.finished)}/{formatCount(counters.total)}
                      </span>
                    </span>
                    <StatusLabel status={jobStateStatus(job.state)} className="justify-self-end sm:justify-self-start" />
                    <span className="hidden text-right font-mono text-xs text-muted-foreground tabular sm:block">
                      {counters.unresolved ? `${formatCount(counters.unresolved)} unresolved` : ''}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {jobs.hasNextPage ? (
            <div className="flex justify-center py-3">
              <Button variant="ghost" disabled={jobs.isFetchingNextPage} onClick={() => jobs.fetchNextPage()}>
                Load more
              </Button>
            </div>
          ) : null}
        </ScrollPane>
      )}
    </Page>
  );
}
