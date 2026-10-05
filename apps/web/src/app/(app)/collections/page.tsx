import type { Metadata } from 'next';
import { CollectionsPage } from '@/components/collections/collections-page';

export const metadata: Metadata = { title: 'Shortlists' };

export default function Page() {
  return <CollectionsPage />;
}
