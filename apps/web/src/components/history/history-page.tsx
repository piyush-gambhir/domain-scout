'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Page, PageHeader } from '../states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { JobHistory } from './job-history';
import { PriceHistory } from './price-history';

const panelClass = 'flex min-w-0 flex-col gap-section data-[state=inactive]:hidden lg:min-h-0 lg:flex-1';

export function HistoryPage() {
  const router = useRouter();
  const view = useSearchParams().get('view') === 'prices' ? 'prices' : 'jobs';
  return (
    <Page>
      <Tabs
        value={view}
        onValueChange={(next) => router.replace(next === 'prices' ? '/history?view=prices' : '/history', { scroll: false })}
        className="flex min-w-0 flex-1 flex-col gap-section lg:min-h-0"
      >
        <PageHeader
          title="History"
          meta={
            <TabsList aria-label="History">
              <TabsTrigger value="jobs">Jobs</TabsTrigger>
              <TabsTrigger value="prices">Prices</TabsTrigger>
            </TabsList>
          }
        />
        <TabsContent value="jobs" className={panelClass}>
          <JobHistory />
        </TabsContent>
        <TabsContent value="prices" className={panelClass}>
          <PriceHistory />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
