'use client';

import { ExportDialog, SnapshotDialog } from './artifact-dialogs';
import type { ScopeOption } from './types';

export interface ArtifactRequest {
  kind: 'export' | 'snapshot';
  defaultScope: string;
}


export function ArtifactDialogsHost({ request, onClose, scopes }: { request: ArtifactRequest | null; onClose: () => void; scopes: ScopeOption[] }) {
  return (
    <>
      <ExportDialog
        key={`export-${request?.defaultScope ?? ''}`}
        open={request?.kind === 'export'}
        onOpenChange={(open) => !open && onClose()}
        scopes={scopes}
        defaultScope={request?.defaultScope}
      />
      <SnapshotDialog
        key={`snapshot-${request?.defaultScope ?? ''}`}
        open={request?.kind === 'snapshot'}
        onOpenChange={(open) => !open && onClose()}
        scopes={scopes}
        defaultScope={request?.defaultScope}
      />
    </>
  );
}
