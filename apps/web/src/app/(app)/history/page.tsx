import type { Metadata } from 'next';
import { Suspense } from 'react';
import { HistoryPage } from '@/components/history/history-page';

export const metadata: Metadata = { title: 'History' };

export default function Page() {
  return (
    <Suspense>
      <HistoryPage />
    </Suspense>
  );
}
