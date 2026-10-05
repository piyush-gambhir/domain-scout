import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WatchView } from '@/components/monitoring/watch-view';

export const metadata: Metadata = { title: 'Watch' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <WatchView key={id} watchId={id.toLowerCase()} />;
}
