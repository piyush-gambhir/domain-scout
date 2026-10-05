'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from './ui/button';

/** Returns to the previous view (results, shortlist) when there is one, else to a fallback route. */
export function BackButton({ fallback, label = 'Back' }: { fallback: string; label?: string }) {
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant="quiet"
      className="-ml-2 px-2"
      onClick={() => (window.history.length > 1 ? router.back() : router.push(fallback))}
    >
      <ArrowLeft />
      {label}
    </Button>
  );
}
