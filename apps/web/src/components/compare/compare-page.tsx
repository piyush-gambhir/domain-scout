'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PageHeader } from '../states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Aftermarket } from './aftermarket';
import { CostComparison } from './cost-comparison';
import { Portfolio } from './portfolio';
import { TransferOptions } from './transfer-options';

const TABS = ['registration', 'transfer', 'aftermarket', 'portfolio'] as const;
type Tab = (typeof TABS)[number];

/** Registration, transfer, aftermarket and portfolio costs, kept as separate purchase paths. */
export function ComparePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'registration';
  const initialDomains = (searchParams.get('domains') ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  // Shared by the domain-based tabs so switching tabs keeps what was typed.
  const [domainsText, setDomainsText] = useState(() => initialDomains.join('\n'));
  const autoRun = initialDomains.length > 0;

  const select = (next: string) => {
    const params = new URLSearchParams(window.location.search);
    if (next === 'registration') params.delete('tab');
    else params.set('tab', next);
    const query = params.toString();
    router.replace(query ? `/compare?${query}` : '/compare', { scroll: false });
  };

  return (
    <>
      <PageHeader title="Compare" />
      <Tabs value={tab} onValueChange={select}>
        <TabsList aria-label="Purchase path">
          <TabsTrigger value="registration">Registration</TabsTrigger>
          <TabsTrigger value="transfer">Transfer</TabsTrigger>
          <TabsTrigger value="aftermarket">Aftermarket</TabsTrigger>
          <TabsTrigger value="portfolio">Portfolio</TabsTrigger>
        </TabsList>
        <TabsContent value="registration">
          <CostComparison path="registration" domainsText={domainsText} onDomainsText={setDomainsText} autoRun={autoRun} />
        </TabsContent>
        <TabsContent value="transfer">
          <CostComparison path="transfer" domainsText={domainsText} onDomainsText={setDomainsText} autoRun={autoRun}>
            {(domains) => <TransferOptions domains={domains} />}
          </CostComparison>
        </TabsContent>
        <TabsContent value="aftermarket">
          <Aftermarket domainsText={domainsText} onDomainsText={setDomainsText} autoRun={autoRun} />
        </TabsContent>
        <TabsContent value="portfolio">
          <Portfolio />
        </TabsContent>
      </Tabs>
    </>
  );
}
