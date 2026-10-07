import type { Metadata } from 'next';
import { WatchingPage } from '@/components/watching/watching-page';

export const metadata: Metadata = { title: 'Watching' };

export default function Page() {
  return <WatchingPage />;
}
