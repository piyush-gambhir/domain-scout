'use client';

import { WatchFormDialog } from '../watching/watch-form';
import type { DomainTarget } from './types';


export function WatchDialog({ open, onOpenChange, target }: { open: boolean; onOpenChange: (open: boolean) => void; target: DomainTarget }) {
  return <WatchFormDialog open={open} onOpenChange={onOpenChange} target={target} />;
}
