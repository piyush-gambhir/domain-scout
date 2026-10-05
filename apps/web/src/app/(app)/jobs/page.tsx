import type { Metadata } from 'next';
import { JobsList } from '@/components/jobs/jobs-list';

export const metadata: Metadata = { title: 'Jobs' };

export default function Page() {
  return <JobsList />;
}
