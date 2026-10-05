import { z } from 'zod';
import { Timestamp, Uuid } from './common.js';
import { Job, JobItem } from './jobs.js';
import { Notice, Watch } from './monitoring.js';
import { Offer } from './pricing.js';

export const EventType = z
  .enum([
    'job.updated',
    'job.progress',
    'result.observed',
    'quote.observed',
    'watch.changed',
    'notice.created',
    'source.cooldown',
    'catalog.updated',
    'stream.reset',
    'heartbeat',
  ])
  .meta({ id: 'EventType' });
export type EventType = z.infer<typeof EventType>;

/** Event types that are compacted after the transient replay window. */
export const TRANSIENT_EVENT_TYPES: readonly EventType[] = ['job.progress', 'heartbeat'];

export const SourceCooldownPayload = z
  .object({
    sourceId: z.string(),
    until: Timestamp,
    reason: z.string(),
  })
  .meta({ id: 'SourceCooldownPayload' });

export const JobProgressPayload = z
  .object({ jobId: Uuid, counters: Job.shape.counters })
  .meta({ id: 'JobProgressPayload' });

export const StreamResetPayload = z
  .object({ reason: z.string(), oldestEventId: z.string().nullable() })
  .meta({ id: 'StreamResetPayload', description: 'The replay cursor expired; refetch state before continuing' });

export const CatalogUpdatedPayload = z
  .object({ providerId: z.string(), suffixCount: z.number().int(), fetchedAt: Timestamp })
  .meta({ id: 'CatalogUpdatedPayload' });

export const EventPayloads = {
  'job.updated': Job,
  'job.progress': JobProgressPayload,
  'result.observed': JobItem,
  'quote.observed': Offer,
  'watch.changed': Watch,
  'notice.created': Notice,
  'source.cooldown': SourceCooldownPayload,
  'catalog.updated': CatalogUpdatedPayload,
  'stream.reset': StreamResetPayload,
  heartbeat: z.object({}),
} as const;

export const DomainEvent = z
  .object({
    contractVersion: z.string(),
    eventId: z.string().meta({ description: 'Monotonic cursor; send as Last-Event-ID to resume' }),
    type: EventType,
    occurredAt: Timestamp,
    jobId: Uuid.nullable(),
    watchId: Uuid.nullable(),
    payload: z.unknown(),
  })
  .meta({ id: 'DomainEvent', description: 'SSE data payload; payload schema depends on type' });
export type DomainEvent = z.infer<typeof DomainEvent>;
export type TypedEvent<T extends EventType> = Omit<DomainEvent, 'type' | 'payload'> & {
  type: T;
  payload: z.infer<(typeof EventPayloads)[T]>;
};

export const EventQuery = z.object({
  jobId: z.string().optional(),
  watchId: z.string().optional(),
  after: z.string().optional().meta({ description: 'Replay cursor; Last-Event-ID header takes precedence' }),
  types: z.string().optional().meta({ description: 'Comma-separated event types' }),
});
