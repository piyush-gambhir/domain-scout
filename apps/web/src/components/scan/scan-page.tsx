'use client';

import { Suspense } from 'react';
import { useIsClient } from '@/lib/use-is-client';
import { ScanForm, ScanFormSkeleton } from './scan-form';

/** The form restores drafts from session storage, so it renders on the client only. */
export function ScanPage() {
  const isClient = useIsClient();
  if (!isClient) return <ScanFormSkeleton />;
  return (
    <Suspense fallback={<ScanFormSkeleton />}>
      <ScanForm />
    </Suspense>
  );
}
