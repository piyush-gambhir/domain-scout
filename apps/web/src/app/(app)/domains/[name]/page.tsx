import type { Metadata } from 'next';
import { DomainPage } from '@/components/domain/domain-detail';

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

export default async function Page({ params }: Props) {
  const { name } = await params;
  const domain = domainFrom(name);
  return <DomainPage key={domain} name={domain} />;
}
