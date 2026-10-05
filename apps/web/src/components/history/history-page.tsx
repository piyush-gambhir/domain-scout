'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { PageHeader } from '../states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { JobHistory } from './job-history';
import { PriceHistory } from './price-history';

export function HistoryPage() {
  const router = useRouter();
  const view = useSearchParams().get('view') === 'prices' ? 'prices' : 'jobs';
  return (
    <>
      <PageHeader title="History" />
      <Tabs value={view} onValueChange={(next) => router.replace(next === 'prices' ? '/history?view=prices' : '/history', { scroll: false })}>
        <TabsList aria-label="History">
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="prices">Prices</TabsTrigger>
        </TabsList>
        <TabsContent value="jobs">
          <JobHistory />
        </TabsContent>
        <TabsContent value="prices">
          <PriceHistory />
        </TabsContent>
      </Tabs>
    </>
  );
}
