'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Page, PageHeader } from '../states';
import { ArtifactSettings } from './artifacts';
import { CoverageSettings } from './coverage';
import { DataSettings } from './data';
import { AppearanceSettings, ChecksSettings, PricingSettings, PrivacySettings } from './preferences';
import { ServiceSettings } from './service';

/** `fill` sections lay out their own scrolling lists; the others scroll as a whole only when long. */
const SECTIONS = [
  { id: 'appearance', label: 'Appearance', fill: false, render: () => <AppearanceSettings /> },
  { id: 'checks', label: 'Checks', fill: false, render: () => <ChecksSettings /> },
  { id: 'pricing', label: 'Pricing', fill: false, render: () => <PricingSettings /> },
  { id: 'privacy', label: 'Privacy', fill: false, render: () => <PrivacySettings /> },
  { id: 'coverage', label: 'Coverage', fill: true, render: () => <CoverageSettings /> },
  { id: 'data', label: 'Data', fill: false, render: () => <DataSettings /> },
  { id: 'artifacts', label: 'Exports', fill: true, render: () => <ArtifactSettings /> },
  { id: 'service', label: 'Service', fill: false, render: () => <ServiceSettings /> },
] as const;

export function SettingsPage() {
  const requested = useSearchParams().get('section');
  const active = SECTIONS.find((s) => s.id === requested) ?? SECTIONS[0];
  return (
    <Page>
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-6 md:flex-row md:gap-8 lg:min-h-0 lg:flex-1">
        <nav aria-label="Settings sections" className="md:w-40 md:shrink-0">
          <ul className="flex flex-wrap gap-0.5 md:flex-col">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <Link
                  href={section.id === 'appearance' ? '/settings' : `/settings?section=${section.id}`}
                  scroll={false}
                  aria-current={section.id === active.id ? 'page' : undefined}
                  className={cn(
                    'flex h-8 items-center rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground',
                    'aria-[current=page]:bg-selected aria-[current=page]:font-medium aria-[current=page]:text-foreground',
                  )}
                >
                  {section.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className={cn('relative -mx-1 flex min-w-0 flex-1 flex-col px-1 lg:min-h-0', !active.fill && 'lg:overflow-y-auto')}>{active.render()}</div>
      </div>
    </Page>
  );
}
