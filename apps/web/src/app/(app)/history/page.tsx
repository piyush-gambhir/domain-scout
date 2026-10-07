import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { HistoryPage } from '@/components/history/history-page';

export const metadata: Metadata = { title: 'History' };

export default async function Page({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  // Price history moved to Settings.
  if ((await searchParams).view === 'prices') redirect('/settings/prices');
  return <HistoryPage />;
}
