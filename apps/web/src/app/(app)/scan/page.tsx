import type { Metadata } from 'next';
import { ScanPage } from '@/components/scan/scan-page';

export const metadata: Metadata = { title: 'Scan' };

export default function Page() {
  return <ScanPage />;
}
