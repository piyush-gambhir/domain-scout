import { redirect } from 'next/navigation';


const MOVED: Record<string, string> = {
  appearance: 'preferences',
  pricing: 'preferences',
  privacy: 'checks',
  checks: 'checks',
  coverage: 'coverage',
  data: 'data',
  artifacts: 'exports',
  service: 'service',
};

export default async function Page({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  const { section } = await searchParams;
  redirect(`/settings/${(section && MOVED[section]) || 'providers'}`);
}
