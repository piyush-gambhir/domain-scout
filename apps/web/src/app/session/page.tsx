import type { Metadata } from 'next';
import { SessionRequired } from '@/components/shell/session-required';

export const metadata: Metadata = { title: 'Session required' };

const REASONS: Record<string, string> = {
  expired: 'That link has expired or was already used. Start a new session from a terminal.',
  unavailable: 'The local backend is not reachable. Start it from a terminal.',
};

export default async function SessionPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  return <SessionRequired reason={reason ? REASONS[reason] : undefined} />;
}
