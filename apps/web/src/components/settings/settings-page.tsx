'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { PageHeader } from '../states';
import { ArtifactSettings } from './artifacts';
import { CoverageSettings } from './coverage';
import { DataSettings } from './data';
import { AppearanceSettings, ChecksSettings, PricingSettings, PrivacySettings } from './preferences';
import { ServiceSettings } from './service';

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', render: () => <AppearanceSettings /> },
  { id: 'checks', label: 'Checks', render: () => <ChecksSettings /> },
  { id: 'pricing', label: 'Pricing', render: () => <PricingSettings /> },
  { id: 'privacy', label: 'Privacy', render: () => <PrivacySettings /> },
  { id: 'coverage', label: 'Coverage', render: () => <CoverageSettings /> },
  { id: 'data', label: 'Data', render: () => <DataSettings /> },
  { id: 'artifacts', label: 'Exports', render: () => <ArtifactSettings /> },
  { id: 'service', label: 'Service', render: () => <ServiceSettings /> },
] as const;

export function SettingsPage() {
  const requested = useSearchParams().get('section');
  const active = SECTIONS.find((s) => s.id === requested) ?? SECTIONS[0];
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-x-12 gap-y-8 md:grid-cols-[11rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections">
          <ul className="flex flex-wrap gap-1 md:flex-col md:gap-0.5">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <Link
                  href={section.id === 'appearance' ? '/settings' : `/settings?section=${section.id}`}
                  scroll={false}
                  aria-current={section.id === active.id ? 'page' : undefined}
                  className={cn(
                    'flex h-9 items-center rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground',
                    'aria-[current=page]:bg-selected aria-[current=page]:font-medium aria-[current=page]:text-foreground',
                  )}
                >
                  {section.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0">{active.render()}</div>
      </div>
    </>
  );
}
