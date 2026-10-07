import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { SettingsPage } from '@/components/settings/settings-page';
import { SETTINGS_SECTIONS, isSettingsSection } from '@/components/settings/sections';

type Props = { params: Promise<{ section: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { section } = await params;
  return { title: SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? 'Settings' };
}

export default async function Page({ params }: Props) {
  const { section } = await params;
  if (!isSettingsSection(section)) notFound();
  return (
    <Suspense>
      <SettingsPage section={section} />
    </Suspense>
  );
}
