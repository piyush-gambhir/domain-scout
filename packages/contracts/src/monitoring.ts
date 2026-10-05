import { z } from 'zod';
import { AsciiDomain, Timestamp, Uuid, envelope, page } from './common.js';
import { ProviderId } from './providers.js';

export const WatchState = z.enum(['active', 'paused']).meta({ id: 'WatchState' });

export const Watch = z
  .object({
    id: Uuid,
    name: z.string(),
    domains: z.array(AsciiDomain),
    includeRegistry: z.boolean(),
    providerIds: z.array(ProviderId).meta({ description: 'Providers queried for exact-name confirmation and quotes; disclosure is explicit' }),
    includeCatalogPrices: z.boolean().meta({ description: 'Track published suffix prices (no names are sent)' }),
    intervalMinutes: z.number().int(),
    state: WatchState,
    destinations: z.array(z.string()),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    lastRunAt: Timestamp.nullable(),
    nextRunAt: Timestamp.nullable(),
    missedRuns: z.number().int().meta({ description: 'Intervals missed while the backend was stopped, since the last run' }),
    lastJobId: Uuid.nullable(),
    unreadNotices: z.number().int(),
  })
  .meta({ id: 'Watch' });
export type Watch = z.infer<typeof Watch>;
export const WatchResponse = envelope(Watch, 'WatchResponse');
export const WatchListResponse = page(Watch, 'WatchListResponse');

export const WatchCreate = z
  .object({
    name: z.string().min(1).max(200),
    domains: z.array(AsciiDomain).min(1).max(5000),
    includeRegistry: z.boolean().default(true),
    providerIds: z.array(ProviderId).default([]),
    includeCatalogPrices: z
      .boolean()
      .default(false)
      .meta({ description: 'Refresh published catalogs of the selected providers; requires providerIds' }),
    intervalMinutes: z
      .number()
      .int()
      .min(15)
      .max(60 * 24 * 30)
      .optional()
      .meta({ description: 'Defaults to settings.monitoring.defaultIntervalMinutes' }),
  })
  .meta({ id: 'WatchCreate' });
export const WatchPatch = z
  .object({
    name: z.string().min(1).max(200).optional(),
    domains: z.array(AsciiDomain).min(1).max(5000).optional(),
    includeRegistry: z.boolean().optional(),
    providerIds: z.array(ProviderId).optional(),
    includeCatalogPrices: z.boolean().optional(),
    intervalMinutes: z.number().int().min(15).max(60 * 24 * 30).optional(),
  })
  .meta({ id: 'WatchPatch' });

export const WatchRunStatus = z
  .enum(['scheduled', 'running', 'completed', 'completed_with_errors', 'missed', 'catch_up', 'cancelled'])
  .meta({ id: 'WatchRunStatus' });

export const WatchRun = z
  .object({
    id: Uuid,
    watchId: Uuid,
    status: WatchRunStatus,
    scheduledFor: Timestamp,
    startedAt: Timestamp.nullable(),
    finishedAt: Timestamp.nullable(),
    jobId: Uuid.nullable(),
    changes: z.number().int(),
    failures: z.number().int(),
    note: z.string().nullable(),
  })
  .meta({ id: 'WatchRun' });
export const WatchRunListResponse = page(WatchRun, 'WatchRunListResponse');

export const NoticeType = z
  .enum(['availability_changed', 'confirmation_changed', 'price_changed'])
  .meta({ id: 'NoticeType' });

export const EvidenceRef = z
  .object({
    kind: z.enum(['registry', 'confirmation', 'offer']),
    id: Uuid,
    observedAt: Timestamp,
    source: z.string(),
    value: z.string().meta({ description: 'Outcome, status or amount with currency' }),
  })
  .meta({ id: 'EvidenceRef' });

export const Notice = z
  .object({
    id: Uuid,
    watchId: Uuid,
    domain: z.string().meta({ description: 'The domain, or `.<suffix>` for catalog price notices' }),
    type: NoticeType,
    summary: z.string(),
    before: EvidenceRef,
    after: EvidenceRef,
    createdAt: Timestamp,
    readAt: Timestamp.nullable(),
  })
  .meta({ id: 'Notice', description: 'Created only from comparable successful evidence; failures never create notices' });
export type Notice = z.infer<typeof Notice>;
export const NoticeListResponse = page(Notice, 'NoticeListResponse');

export const NoticeQuery = z.object({
  watchId: z.string().optional(),
  unread: z.enum(['true', 'false']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const NoticesMarkRead = z
  .object({
    ids: z.array(Uuid).optional(),
    all: z.boolean().optional(),
    watchId: Uuid.optional().meta({ description: 'With all: mark only this watch\'s notices read' }),
  })
  .meta({ id: 'NoticesMarkRead' });
