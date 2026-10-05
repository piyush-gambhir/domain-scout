import type { Metadata } from 'next';
import { PageHeader } from '@/components/states';

export const metadata: Metadata = { title: 'Settings' };

export default function Page() {
  return <PageHeader title="Settings" />;
}
