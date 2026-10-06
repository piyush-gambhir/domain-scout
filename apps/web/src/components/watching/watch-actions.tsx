'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ellipsis, Pause, Pencil, Play, RefreshCw, Trash } from 'lucide-react';
import { toast } from 'sonner';
import type { Watch } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { watchesDeletedHere } from '@/lib/events';
import { qk } from '@/lib/queries';
import { useIdempotency } from '@/lib/use-idempotency';
import { isTerminal, useLiveJob } from '@/lib/use-job';
import { cn } from '@/lib/utils';
import { useJobStarted } from '../actions/use-job-started';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { WatchFormDialog } from './watch-form';

/** Follows a run-now job and refreshes the watch, its runs and notices when it finishes. */
function useRunFollower(watchId: string) {
  const client = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useLiveJob(jobId);
  const done = isTerminal(job.data);
  useEffect(() => {
    if (!jobId || !done) return;
    void client.invalidateQueries({ queryKey: qk.watch(watchId) });
    void client.invalidateQueries({ queryKey: qk.watches });
    void client.invalidateQueries({ queryKey: qk.notices });
  }, [client, watchId, jobId, done]);
  return { setJobId, running: Boolean(jobId && job.data && !done) };
}

/** Run now, pause or resume, edit and delete for one watch. `compact` renders icon buttons for list rows. */
export function WatchActions({ watch, compact, onDeleted }: { watch: Watch; compact?: boolean; onDeleted?: () => void }) {
  const client = useQueryClient();
  const started = useJobStarted();
  const idempotency = useIdempotency();
  const follower = useRunFollower(watch.id);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const store = (updated: Watch) => {
    client.setQueryData(qk.watch(updated.id), updated);
    void client.invalidateQueries({ queryKey: qk.watches });
  };

  const run = useMutation({
    mutationFn: async () => (await api.call('runWatch', { params: { id: watch.id }, idempotencyKey: idempotency.keyFor({ runWatch: watch.id }) })).data,
    onSuccess: (job) => {
      idempotency.reset();
      follower.setJobId(job.id);
      started(job, `Running ${watch.name}`);
      void client.invalidateQueries({ queryKey: qk.watches });
    },
  });
  const pause = useMutation({
    mutationFn: async () => (await api.call('pauseWatch', { params: { id: watch.id } })).data,
    onSuccess: store,
  });
  const resume = useMutation({
    mutationFn: async () => (await api.call('resumeWatch', { params: { id: watch.id } })).data,
    onSuccess: store,
  });
  const remove = useMutation({
    mutationFn: async () => {
      watchesDeletedHere.add(watch.id);
      return api.call('deleteWatch', { params: { id: watch.id } });
    },
    onSuccess: () => {
      toast.success(`Deleted ${watch.name}`);
      setDeleting(false);
      client.removeQueries({ queryKey: qk.watch(watch.id) });
      void client.invalidateQueries({ queryKey: qk.watches });
      void client.invalidateQueries({ queryKey: qk.notices });
      onDeleted?.();
    },
  });

  const running = run.isPending || follower.running;
  const paused = watch.state === 'paused';
  const toggle = paused ? resume : pause;

  return (
    <>
      <div className="flex items-center gap-1">
        <Button
          size={compact ? 'icon-sm' : 'sm'}
          variant={compact ? 'quiet' : 'secondary'}
          aria-label={compact ? `Run ${watch.name} now` : undefined}
          aria-description={watch.destinations.length ? `Sends ${watch.domains.length} names to ${watch.destinations.join(', ')}` : undefined}
          title={watch.destinations.length ? `Sends names to ${watch.destinations.join(', ')}` : undefined}
          disabled={running}
          onClick={() => run.mutate()}
        >
          <RefreshCw className={cn(running && 'motion-safe:animate-spin')} />
          {compact ? null : running ? 'Running' : 'Run now'}
        </Button>
        <Button
          size={compact ? 'icon-sm' : 'sm'}
          variant={compact ? 'quiet' : 'secondary'}
          aria-label={compact ? `${paused ? 'Resume' : 'Pause'} ${watch.name}` : undefined}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate()}
        >
          {paused ? <Play /> : <Pause />}
          {compact ? null : paused ? 'Resume' : 'Pause'}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant={compact ? 'quiet' : 'secondary'} aria-label={`More actions for ${watch.name}`}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Pencil />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem className="text-negative" onSelect={() => setDeleting(true)}>
              <Trash />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <WatchFormDialog open={editing} onOpenChange={setEditing} watch={watch} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${watch.name}?`}
        description="The watch and its schedule are removed. Retained evidence is kept."
        confirmLabel="Delete watch"
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
