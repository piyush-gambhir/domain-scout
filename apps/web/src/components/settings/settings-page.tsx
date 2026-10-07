'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { PriceHistory } from '../history/price-history';
import { Page, SectionTitle } from '../states';
import { ArtifactSettings } from './artifacts';
import { CoverageSettings } from './coverage';
import { DataSettings } from './data';
import { AppearanceSettings, ChecksSettings, PricingSettings, PrivacySettings, SearchDefaults } from './preferences';
import { ProvidersSettings } from './providers';
import { SETTINGS_SECTIONS, type SettingsSection } from './sections';
import { ServiceSettings } from './service';

/** `fill` sections lay out their own scrolling lists; the others scroll as a whole only when long. */
const CONTENT: Record<SettingsSection, { fill: boolean; render: () => React.ReactNode }> = {
  providers: { fill: true, render: () => <ProvidersSettings /> },
  preferences: {
    fill: false,
    render: () => (
      <div className="flex max-w-4xl flex-col gap-8">
        <div>
          <SectionTitle>Search</SectionTitle>
          <SearchDefaults />
        </div>
        <PricingSettings />
        <div>
          <SectionTitle>Theme</SectionTitle>
          <AppearanceSettings />
        </div>
      </div>
    ),
  },
  checks: {
    fill: false,
    render: () => (
      <div className="flex flex-col gap-8">
        <ChecksSettings />
        <PrivacySettings />
      </div>
    ),
  },
  coverage: { fill: true, render: () => <CoverageSettings /> },
  prices: { fill: true, render: () => <PriceHistory /> },
  exports: { fill: true, render: () => <ArtifactSettings /> },
  data: { fill: false, render: () => <DataSettings /> },
  service: { fill: false, render: () => <ServiceSettings /> },
};

export function SettingsPage({ section }: { section: SettingsSection }) {
  const active = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];
  const content = CONTENT[active.id];
  return (
    <Page>
      <div className="flex flex-col gap-6 md:flex-row md:gap-8 lg:min-h-0 lg:flex-1">
        <nav aria-label="Settings sections" className="md:w-44 md:shrink-0">
          <h1 className="mb-2 px-2.5 text-base font-semibold tracking-tight">Settings</h1>
          <ul className="flex flex-wrap gap-0.5 md:flex-col">
            {SETTINGS_SECTIONS.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/settings/${item.id}`}
                  scroll={false}
                  aria-current={item.id === active.id ? 'page' : undefined}
                  className={cn(
                    'flex h-8 items-center rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground',
                    'aria-[current=page]:bg-selected aria-[current=page]:font-medium aria-[current=page]:text-foreground',
                  )}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className={cn('relative -mx-1 flex min-w-0 flex-1 flex-col px-1 lg:min-h-0', !content.fill && 'lg:overflow-y-auto')}>
          <h2 className="sr-only">{active.label}</h2>
          {content.render()}
        </div>
      </div>
    </Page>
  );
}
