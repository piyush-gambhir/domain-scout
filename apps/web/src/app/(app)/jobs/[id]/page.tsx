import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { JobView } from '@/components/jobs/job-view';

export const metadata: Metadata = { title: 'Job' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return (
    <Suspense>
      <JobView key={id} jobId={id.toLowerCase()} />
    </Suspense>
  );
}
