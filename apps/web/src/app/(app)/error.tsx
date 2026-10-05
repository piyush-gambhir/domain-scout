'use client';

import { ErrorState, Page, PageHeader } from '@/components/states';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Page>
      <PageHeader title="Something went wrong" />
      <ErrorState error={error} onRetry={reset} />
    </Page>
  );
}
