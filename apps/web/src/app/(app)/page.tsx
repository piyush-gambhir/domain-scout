import type { Metadata } from 'next';
import { SearchHome } from '@/components/search/search-home';

export const metadata: Metadata = { title: 'Search' };

export default function Page() {
  return <SearchHome />;
}
