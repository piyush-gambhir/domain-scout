'use client';

import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ExportArtifact, SnapshotArtifact } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { formatBytes, plural } from '@/lib/format';
import { qk } from '@/lib/queries';
import { apiDownloadUrl } from '../actions/artifact-dialogs';
import { RelativeTime } from '../domain/time';
import { EmptyState, ErrorState, ScrollPane, SectionTitle } from '../states';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { SkeletonRows } from '../ui/skeleton';

const SCOPE_LABEL: Record<string, string> = {
  selection: 'Selected rows',
  filter: 'Filtered results',
  job: 'Whole job',
  collection: 'Shortlist',
  domains: 'Chosen domains',
  all: 'Everything',
};

const rowClass = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-md px-2.5 py-1.5 hover:bg-hover';

function DownloadLink({ href, label, description }: { href: string; label: string; description: string }) {
  return (
    <Button size="sm" variant="ghost" asChild>
      <a href={apiDownloadUrl(href)} download aria-label={description}>
        <Download />
        {label}
      </a>
    </Button>
  );
}

type Pending = { kind: 'export'; item: ExportArtifact } | { kind: 'snapshot'; item: SnapshotArtifact };

export function ArtifactSettings() {
  const client = useQueryClient();
  const [deleting, setDeleting] = useState<Pending | null>(null);
  const exports = useInfiniteQuery({
    queryKey: [...qk.artifacts, 'exports'],
    queryFn: ({ pageParam, signal }) => api.call('listExports', { query: { cursor: pageParam, limit: 100 }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const snapshots = useInfiniteQuery({
    queryKey: [...qk.artifacts, 'snapshots'],
    queryFn: ({ pageParam, signal }) => api.call('listSnapshots', { query: { cursor: pageParam, limit: 100 }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const exportRows = exports.data?.pages.flatMap((p) => p.data) ?? [];
  const snapshotRows = snapshots.data?.pages.flatMap((p) => p.data) ?? [];

  const remove = useMutation({
    mutationFn: async (target: Pending) =>
      target.kind === 'export' ? api.call('deleteExport', { params: { id: target.item.id } }) : api.call('deleteSnapshot', { params: { id: target.item.id } }),
    onSuccess: () => {
      toast.success('Deleted');
      setDeleting(null);
      void client.invalidateQueries({ queryKey: qk.artifacts });
    },
  });

  return (
    <section aria-label="Artifacts" className="flex min-w-0 flex-col gap-8 lg:min-h-0 lg:flex-1 xl:flex-row">
      <div className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1">
        <SectionTitle className="px-2.5">Exports</SectionTitle>
        {exports.isPending ? (
          <SkeletonRows rows={3} />
        ) : exports.isError ? (
          <ErrorState error={exports.error} onRetry={() => exports.refetch()} />
        ) : exportRows.length === 0 ? (
          <EmptyState>No exports.</EmptyState>
        ) : (
          <ScrollPane>
          <ul className="flex flex-col" aria-label="Exports">
            {exportRows.map((item) => (
              <li key={item.id} className={rowClass} data-testid="export-row">
                <div className="min-w-0">
                  <p className="truncate font-mono text-[13px]">{item.fileName}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.format.toUpperCase()} · {SCOPE_LABEL[item.scope.kind] ?? item.scope.kind} · {plural(item.itemCount, 'row')} · {formatBytes(item.sizeBytes)} · <RelativeTime iso={item.createdAt} />
                    {item.warnings.length ? ` · ${plural(item.warnings.length, 'warning')}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <DownloadLink href={item.downloadPath} label="Download" description={`Download ${item.fileName}`} />
                  <Button size="icon-sm" variant="quiet" aria-label={`Delete ${item.fileName}`} onClick={() => setDeleting({ kind: 'export', item })}>
                    <X />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {exports.hasNextPage ? (
            <Button variant="ghost" className="mt-2" disabled={exports.isFetchingNextPage} onClick={() => exports.fetchNextPage()}>
              Load more
            </Button>
          ) : null}
          </ScrollPane>
        )}
      </div>

      <div className="flex min-w-0 flex-col lg:min-h-0 lg:flex-1">
        <SectionTitle className="px-2.5">Snapshots</SectionTitle>
        {snapshots.isPending ? (
          <SkeletonRows rows={3} />
        ) : snapshots.isError ? (
          <ErrorState error={snapshots.error} onRetry={() => snapshots.refetch()} />
        ) : snapshotRows.length === 0 ? (
          <EmptyState>No snapshots.</EmptyState>
        ) : (
          <ScrollPane>
          <ul className="flex flex-col" aria-label="Snapshots">
            {snapshotRows.map((item) => {
              const included = [item.include.evidence && 'evidence', item.include.registration && 'registration', item.include.prices && 'prices', item.include.notes && 'notes'].filter(Boolean);
              return (
                <li key={item.id} className={rowClass} data-testid="snapshot-row">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {SCOPE_LABEL[item.scope.kind] ?? item.scope.kind} · {plural(item.itemCount, 'item')} · {included.join(', ') || 'names only'} · {formatBytes(item.sizeBytes)} · <RelativeTime iso={item.createdAt} />
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    <DownloadLink href={`/snapshots/${item.id}/download?format=html`} label="HTML" description={`Download ${item.title} as HTML`} />
                    <DownloadLink href={`/snapshots/${item.id}/download?format=json`} label="JSON" description={`Download ${item.title} as JSON`} />
                    <Button size="icon-sm" variant="quiet" aria-label={`Delete ${item.title}`} onClick={() => setDeleting({ kind: 'snapshot', item })}>
                      <X />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          {snapshots.hasNextPage ? (
            <Button variant="ghost" className="mt-2" disabled={snapshots.isFetchingNextPage} onClick={() => snapshots.fetchNextPage()}>
              Load more
            </Button>
          ) : null}
          </ScrollPane>
        )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.kind === 'export' ? deleting.item.fileName : (deleting?.item.title ?? '')}?`}
        description={deleting?.kind === 'snapshot' ? 'The HTML and JSON files are removed.' : 'The export file is removed.'}
        confirmLabel="Delete"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </section>
  );
}
