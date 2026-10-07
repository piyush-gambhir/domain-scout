'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import {
  TERMINAL_JOB_STATES,
  type DomainEvent,
  type EventType,
  type Job,
  type JobItem,
  type OperationResponse,
  type Watch,
} from '@domain-scout/contracts';
import { qk } from './queries';

type ResultsPage = OperationResponse<'listJobResults'>;

const EVENT_TYPES: EventType[] = [
  'job.updated',
  'job.progress',
  'result.observed',
  'quote.observed',
  'watch.changed',
  'watch.deleted',
  'notice.created',
  'source.cooldown',
  'catalog.updated',
  'stream.reset',
  'heartbeat',
];

/** Replace items in every cached results page of a job, in place. */
export function patchResultItems(client: QueryClient, jobId: string, items: Map<string, JobItem>) {
  client.setQueriesData<InfiniteData<ResultsPage>>({ queryKey: qk.jobResults(jobId) }, (data) => {
    if (!data) return data;
    let changed = false;
    const pages = data.pages.map((page) => {
      let next: JobItem[] | null = null;
      page.data.forEach((item, index) => {
        const update = items.get(item.id);
        if (update) {
          next ??= page.data.slice();
          next[index] = update;
        }
      });
      if (!next) return page;
      changed = true;
      return { ...page, data: next };
    });
    return changed ? { ...data, pages } : data;
  });
}

/** True when a results filter can change membership or order as items finish (anything beyond input order). */
function changesWithResults(filter: unknown): boolean {
  if (!filter || typeof filter !== 'object') return false;
  return Object.entries(filter as Record<string, unknown>).some(
    ([key, value]) => value !== undefined && !(key === 'sort' && value === 'input') && !(key === 'order' && value === 'asc'),
  );
}

export interface JobEventsState {
  /** True while the SSE stream is open; callers poll when it is not. */
  live: boolean;
}

/**
 * Subscribes to /api/v1/events for one job and keeps the job, results and evidence caches current.
 * Result updates are batched; terminal transitions and stream resets refetch authoritative state.
 * When the stream fails (endpoint missing, auth, network) it reports `live: false` so pages can
 * fall back to polling, and retries the stream later with an `after` cursor.
 */
export function useJobEvents(jobId: string | null | undefined, onEvent?: (event: DomainEvent) => void): JobEventsState {
  const client = useQueryClient();
  const [live, setLive] = useState(false);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    if (!jobId || typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let lastId = 0;
    let disposed = false;
    let lastMembershipRefresh = 0;
    let membershipTimer: ReturnType<typeof setTimeout> | null = null;

    // In-place patches cannot add, drop or reorder rows. Filtered or sorted views refetch at most
    // every 3 seconds (trailing), so new matches appear and totals stay right.
    const refreshMembership = () => {
      membershipTimer = null;
      lastMembershipRefresh = Date.now();
      void client.invalidateQueries(
        {
          queryKey: qk.jobResults(jobId),
          predicate: (query) => changesWithResults(query.queryKey[2]),
          refetchType: 'active',
        },
        // Let a slow refetch finish instead of restarting it every window.
        { cancelRefetch: false },
      );
    };
    const scheduleMembershipRefresh = () => {
      if (membershipTimer) return;
      membershipTimer = setTimeout(refreshMembership, Math.max(0, 3000 - (Date.now() - lastMembershipRefresh)));
    };
    const pendingItems = new Map<string, JobItem>();

    const flush = () => {
      flushTimer = null;
      if (pendingItems.size === 0) return;
      const batch = new Map(pendingItems);
      pendingItems.clear();
      patchResultItems(client, jobId, batch);
      for (const item of batch.values()) {
        void client.invalidateQueries({ queryKey: qk.evidence(item.subject), refetchType: 'active' });
      }
      scheduleMembershipRefresh();
    };

    const refetchAll = () => {
      void client.invalidateQueries({ queryKey: qk.job(jobId) });
      void client.invalidateQueries({ queryKey: qk.jobResults(jobId) });
    };

    const handle = (message: MessageEvent<string>) => {
      let event: DomainEvent;
      try {
        event = JSON.parse(message.data) as DomainEvent;
      } catch {
        return;
      }
      const id = Number(event.eventId ?? message.lastEventId);
      if (Number.isFinite(id) && id > 0) {
        if (id <= lastId) return; // duplicate after a reconnect replay
        lastId = id;
      }
      onEventRef.current?.(event);
      switch (event.type) {
        case 'job.updated': {
          const job = event.payload as Job;
          const previous = client.getQueryData<Job>(qk.job(job.id));
          // Events omit the restorable input text (only GET /jobs/:id carries it); keep the cached copy.
          const text = job.input.text ?? previous?.input.text ?? null;
          client.setQueryData(qk.job(job.id), text === job.input.text ? job : { ...job, input: { ...job.input, text } });
          void client.invalidateQueries({ queryKey: qk.jobs() });
          const nowTerminal = TERMINAL_JOB_STATES.includes(job.state);
          if (nowTerminal && previous?.state !== job.state) {
            flush();
            void client.invalidateQueries({ queryKey: qk.jobResults(job.id) });
          }
          break;
        }
        case 'job.progress': {
          const payload = event.payload as { jobId: string; counters: Job['counters'] };
          client.setQueryData<Job>(qk.job(payload.jobId), (job) => (job ? { ...job, counters: payload.counters } : job));
          break;
        }
        case 'result.observed': {
          const item = event.payload as JobItem;
          pendingItems.set(item.id, item);
          flushTimer ??= setTimeout(flush, 250);
          break;
        }
        case 'quote.observed':
          void client.invalidateQueries({ queryKey: ['evidence'] });
          break;
        case 'catalog.updated':
          void client.invalidateQueries({ queryKey: ['evidence'] });
          void client.invalidateQueries({ queryKey: ['prices'] });
          break;
        case 'notice.created':
          void client.invalidateQueries({ queryKey: qk.notices });
          break;
        case 'stream.reset':
          refetchAll();
          break;
        default:
          break;
      }
    };

    const open = () => {
      if (disposed) return;
      const params = new URLSearchParams({ jobId });
      if (lastId > 0) params.set('after', String(lastId));
      source = new EventSource(`/api/v1/events?${params.toString()}`);
      source.onopen = () => setLive(true);
      source.onmessage = handle;
      for (const type of EVENT_TYPES) source.addEventListener(type, handle as EventListener);
      source.onerror = () => {
        setLive(false);
        // CONNECTING means the browser is already retrying with Last-Event-ID; CLOSED means it gave up.
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          retryTimer = setTimeout(() => {
            refetchAll();
            open();
          }, 20_000);
        }
      };
    };

    open();
    return () => {
      disposed = true;
      source?.close();
      if (retryTimer) clearTimeout(retryTimer);
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      if (membershipTimer) clearTimeout(membershipTimer);
      setLive(false);
    };
  }, [jobId, client]);

  return { live };
}

const WATCH_EVENT_TYPES: EventType[] = ['watch.changed', 'watch.deleted', 'notice.created', 'stream.reset'];

/** Watches deleted from this tab, so the tab that deleted one does not also announce it. */
export const watchesDeletedHere = new Set<string>();

/**
 * Keeps watch and notice views current across tabs: changes refresh them, and a deleted watch
 * disappears. Mounted only on monitoring pages, since browsers allow few open streams per host.
 */
export function useWatchEvents(onDeleted?: (watchId: string) => void) {
  const client = useQueryClient();
  const onDeletedRef = useRef(onDeleted);
  useEffect(() => {
    onDeletedRef.current = onDeleted;
  });

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let lastId = 0;
    let disposed = false;

    const refresh = () => {
      void client.invalidateQueries({ queryKey: qk.watches });
      void client.invalidateQueries({ queryKey: qk.notices });
    };
    const handle = (message: MessageEvent<string>) => {
      let event: DomainEvent;
      try {
        event = JSON.parse(message.data) as DomainEvent;
      } catch {
        return;
      }
      const id = Number(event.eventId ?? message.lastEventId);
      if (Number.isFinite(id) && id > 0) {
        if (id <= lastId) return;
        lastId = id;
      }
      if (event.type === 'watch.changed') {
        const watch = event.payload as Watch;
        client.setQueryData(qk.watch(watch.id), watch);
        void client.invalidateQueries({ queryKey: qk.watches, exact: true });
      } else if (event.type === 'watch.deleted') {
        // The tombstone carries only the id; the watch's own ref is null so its details never replay.
        const { watchId } = event.payload as { watchId: string };
        refresh();
        onDeletedRef.current?.(watchId);
      } else if (event.type === 'notice.created' || event.type === 'stream.reset') {
        refresh();
      }
    };

    const open = () => {
      if (disposed) return;
      const params = new URLSearchParams({ types: WATCH_EVENT_TYPES.join(',') });
      if (lastId > 0) params.set('after', String(lastId));
      source = new EventSource(`/api/v1/events?${params.toString()}`);
      source.onmessage = handle;
      for (const type of WATCH_EVENT_TYPES) source.addEventListener(type, handle as EventListener);
      source.onerror = () => {
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          retryTimer = setTimeout(() => {
            refresh();
            open();
          }, 20_000);
        }
      };
    };

    open();
    return () => {
      disposed = true;
      source?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [client]);
}
