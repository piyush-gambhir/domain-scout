'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Job } from '@domain-scout/contracts';
import { qk } from '@/lib/queries';

/** Toast for a submitted job with a shortcut to its progress page. */
export function useJobStarted() {
  const router = useRouter();
  const client = useQueryClient();
  return useCallback(
    (job: Job, message: string) => {
      client.setQueryData(qk.job(job.id), job);
      void client.invalidateQueries({ queryKey: qk.jobs() });
      toast.success(message, { action: { label: 'Open', onClick: () => router.push(`/jobs/${job.id}`) } });
    },
    [client, router],
  );
}
