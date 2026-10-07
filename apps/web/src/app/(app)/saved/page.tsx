import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SavedPage } from '@/components/saved/saved-page';

export const metadata: Metadata = { title: 'Saved' };

export default function Page() {
  return (
    <Suspense>
      <SavedPage />
    </Suspense>
  );
}
