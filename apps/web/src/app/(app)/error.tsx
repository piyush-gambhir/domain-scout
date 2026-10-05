'use client';

import { ErrorState, PageHeader } from '@/components/states';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <PageHeader title="Something went wrong" />
      <ErrorState error={error} onRetry={reset} />
    </>
  );
}
