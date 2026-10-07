import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { SearchResultsPage } from '@/components/results/results-page';

export const metadata: Metadata = { title: 'Results' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return (
    <Suspense>
      <SearchResultsPage key={id} jobId={id.toLowerCase()} />
    </Suspense>
  );
}
