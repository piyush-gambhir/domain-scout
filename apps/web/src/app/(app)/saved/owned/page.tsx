import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SavedPage } from '@/components/saved/saved-page';

export const metadata: Metadata = { title: 'Owned domains' };

export default function Page() {
  return (
    <Suspense>
      <SavedPage owned />
    </Suspense>
  );
}
