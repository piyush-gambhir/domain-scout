import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ComparePage } from '@/components/compare/compare-page';

export const metadata: Metadata = { title: 'Compare' };

export default function Page() {
  return (
    <Suspense>
      <ComparePage />
    </Suspense>
  );
}
