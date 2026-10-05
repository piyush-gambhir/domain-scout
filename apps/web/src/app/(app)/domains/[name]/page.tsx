import type { Metadata } from 'next';
import { BackButton } from '@/components/back-button';
import { DomainDetail } from '@/components/domain/domain-detail';

type Props = { params: Promise<{ name: string }> };

function domainFrom(raw: string) {
  try {
    return decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name } = await params;
  return { title: domainFrom(name) };
}

export default async function DomainPage({ params }: Props) {
  const { name } = await params;
  return (
    <div className="max-w-4xl">
      <BackButton fallback="/jobs" />
      <DomainDetail name={domainFrom(name)} variant="page" />
    </div>
  );
}
