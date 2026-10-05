import { z } from 'zod';
import { Timestamp, Uuid, envelope, page } from './common.js';
import { ResultFilter } from './jobs.js';

export const ExportScope = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('selection'), itemIds: z.array(Uuid).min(1).max(100_000) }).meta({ id: 'SelectionScope' }),
    z.object({ kind: z.literal('filter'), jobId: Uuid, filter: ResultFilter }).meta({ id: 'FilterScope' }),
    z.object({ kind: z.literal('job'), jobId: Uuid }).meta({ id: 'JobScope' }),
    z.object({ kind: z.literal('collection'), collectionId: Uuid }).meta({ id: 'CollectionScope' }),
    z.object({ kind: z.literal('domains'), domains: z.array(z.string()).min(1).max(100_000) }).meta({ id: 'DomainsScope' }),
    z.object({ kind: z.literal('all') }).meta({ id: 'AllScope' }),
  ])
  .meta({ id: 'ExportScope', description: 'Resolved to stable item and evidence ids when the export is created' });
export type ExportScope = z.infer<typeof ExportScope>;

export const ExportField = z
  .enum([
    'domain',
    'unicode',
    'suffix',
    'outcome',
    'checkedAt',
    'freshness',
    'source',
    'protocol',
    'reason',
    'eligibility',
    'registrar',
    'expiresAt',
    'confirmation',
    'priceProvider',
    'priceKind',
    'registration',
    'renewal',
    'currency',
    'priceObservedAt',
    'notes',
  ])
  .meta({ id: 'ExportField' });
export type ExportField = z.infer<typeof ExportField>;

export const DEFAULT_EXPORT_FIELDS: readonly ExportField[] = [
  'domain',
  'unicode',
  'suffix',
  'outcome',
  'checkedAt',
  'freshness',
  'source',
  'reason',
  'confirmation',
  'priceProvider',
  'priceKind',
  'registration',
  'renewal',
  'currency',
];

export const ExportCreate = z
  .object({
    format: z.enum(['txt', 'csv', 'json']),
    scope: ExportScope,
    fields: z.array(ExportField).optional(),
    includeNotes: z.boolean().default(false),
    candidatesOnly: z
      .boolean()
      .default(false)
      .meta({ description: 'TXT only: keep names with no registry record or a positive provider confirmation' }),
  })
  .meta({ id: 'ExportCreate' });
export type ExportCreate = z.input<typeof ExportCreate>;

export const ExportArtifact = z
  .object({
    id: Uuid,
    format: z.enum(['txt', 'csv', 'json']),
    scope: ExportScope,
    fields: z.array(ExportField),
    itemCount: z.number().int(),
    fileName: z.string().meta({ description: 'Download file name' }),
    sizeBytes: z.number().int(),
    createdAt: Timestamp,
    downloadPath: z.string().meta({ description: 'API path that returns the file' }),
    warnings: z.array(z.string()),
  })
  .meta({ id: 'ExportArtifact' });
export type ExportArtifact = z.infer<typeof ExportArtifact>;
export const ExportResponse = envelope(ExportArtifact, 'ExportResponse');
export const ExportListResponse = page(ExportArtifact, 'ExportListResponse');

export const SnapshotCreate = z
  .object({
    title: z.string().min(1).max(200),
    scope: ExportScope,
    include: z
      .object({
        evidence: z.boolean().default(true),
        prices: z.boolean().default(true),
        registration: z.boolean().default(true),
        notes: z.boolean().default(false),
      })
      .default({ evidence: true, prices: true, registration: true, notes: false }),
  })
  .meta({ id: 'SnapshotCreate' });
export type SnapshotCreate = z.input<typeof SnapshotCreate>;

export const SnapshotArtifact = z
  .object({
    id: Uuid,
    title: z.string(),
    scope: ExportScope,
    include: z.object({ evidence: z.boolean(), prices: z.boolean(), registration: z.boolean(), notes: z.boolean() }),
    itemCount: z.number().int(),
    createdAt: Timestamp,
    htmlPath: z.string(),
    jsonPath: z.string(),
    sizeBytes: z.number().int(),
  })
  .meta({ id: 'SnapshotArtifact', description: 'Self-contained HTML plus JSON; opening it runs no queries' });
export type SnapshotArtifact = z.infer<typeof SnapshotArtifact>;
export const SnapshotResponse = envelope(SnapshotArtifact, 'SnapshotResponse');
export const SnapshotListResponse = page(SnapshotArtifact, 'SnapshotListResponse');

export const SnapshotPreview = z
  .object({
    itemCount: z.number().int(),
    fields: z.array(z.string()),
    includesNotes: z.boolean(),
    sample: z.array(z.record(z.string(), z.unknown())),
  })
  .meta({ id: 'SnapshotPreview', description: 'What a snapshot would contain, for inspection before saving' });
export const SnapshotPreviewResponse = envelope(SnapshotPreview, 'SnapshotPreviewResponse');
