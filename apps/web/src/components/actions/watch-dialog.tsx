'use client';

import { WatchFormDialog } from '../monitoring/watch-form';
import type { DomainTarget } from './types';

/** Watch a selection of results or shortlist entries. Same form and disclosure as /monitoring. */
export function WatchDialog({ open, onOpenChange, target }: { open: boolean; onOpenChange: (open: boolean) => void; target: DomainTarget }) {
  return <WatchFormDialog open={open} onOpenChange={onOpenChange} target={target} />;
}
