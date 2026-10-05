import { Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CONTRACT_VERSION, EventType, type DomainEvent } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { ApiInput, ApiRoute, type RouteInput } from '../core/route.js';
import { ShutdownCoordinator } from '../runtime/shutdown.js';
import { EventsService, type EventFilter } from './events.service.js';

export interface SseOptions {
  heartbeatMs: number;
  /** Events read per query while replaying; bounds memory and event-loop blocking. */
  batchSize: number;
}
/** Provider token; tests override it to shorten the heartbeat. */
export const SSE_OPTIONS = Symbol('SSE_OPTIONS');
export const DEFAULT_SSE_OPTIONS: SseOptions = { heartbeatMs: 15_000, batchSize: 500 };

/** One SSE message. JSON.stringify never emits raw newlines, so `data:` stays one line. */
export function formatSse(event: DomainEvent): string {
  // An `id: 0` line would reset the browser's Last-Event-ID, so a cursor of 0 is never sent.
  const id = event.eventId && event.eventId !== '0' ? `id: ${event.eventId}\n` : '';
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * GET /events: server-sent DomainEvents. Replays from Last-Event-ID (or ?after=), then streams live
 * events as they commit. Without a cursor the stream starts at the current end. A cursor older than
 * the retained events (or from another database) gets `stream.reset`, after which the stream
 * continues live from the current end and the client must refetch state. Heartbeats carry the
 * latest scanned cursor so reconnects do not rescan filtered-out events. `stream.reset` and
 * `heartbeat` are sent regardless of the `types` filter.
 */
@Controller()
export class EventsController {
  /** Open streams and their cleanup functions. */
  private readonly open = new Map<Response, () => void>();
  private readonly options: SseOptions;

  constructor(
    private readonly events: EventsService,
    private readonly clock: Clock,
    shutdown: ShutdownCoordinator,
    @Inject(SSE_OPTIONS) options: Partial<SseOptions>,
  ) {
    this.options = { ...DEFAULT_SSE_OPTIONS, ...options };
    // End streams first so app.close() is not held open by long-lived responses.
    shutdown.onStopping(() => this.closeAll(), 'sse');
  }

  @ApiRoute('streamEvents')
  stream(@ApiInput() input: RouteInput<'streamEvents'>, @Req() req: Request, @Res() res: Response) {
    const filter = parseFilter(input.query);
    const cursor = parseCursor(req.headers['last-event-id'], input.query.after);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);

    let position: number;
    const latest = this.events.latestId();
    if (cursor === null) {
      position = latest;
    } else if (cursor > latest || cursor < this.events.deletedThrough()) {
      position = latest;
      const oldest = this.events.oldestId();
      res.write(
        formatSse(
          this.synthetic('stream.reset', position, {
            reason: cursor > latest ? 'cursor_unknown' : 'cursor_expired',
            oldestEventId: oldest === null ? null : String(oldest),
          }),
        ),
      );
    } else {
      position = cursor;
    }

    let closed = false;
    let waitingForDrain = false;
    // Every write goes through here: when the socket buffer is full, stop producing until 'drain'.
    const send = (chunk: string) => {
      if (res.write(chunk) || waitingForDrain) return;
      waitingForDrain = true;
      res.once('drain', () => {
        waitingForDrain = false;
        pump();
      });
    };
    const pump = () => {
      if (closed || waitingForDrain) return;
      for (;;) {
        const batch = this.events.read(position, filter, this.options.batchSize);
        const complete = batch.length < this.options.batchSize;
        for (const event of batch) send(formatSse(event));
        // A short batch means every matching event up to the current end was delivered.
        position = complete ? Math.max(position, this.events.latestId()) : Number(batch[batch.length - 1]!.eventId);
        if (complete || waitingForDrain) return;
      }
    };

    const unsubscribe = this.events.onWake(pump);
    const heartbeat = setInterval(() => {
      // A stalled reader gets no further heartbeats until it drains, so buffers stay bounded.
      if (!closed && !waitingForDrain) send(formatSse(this.synthetic('heartbeat', position, {})));
    }, this.options.heartbeatMs);
    heartbeat.unref();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      this.open.delete(res);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    this.open.set(res, cleanup);
    pump();
  }

  /** Ends every open stream (used when stopping). */
  closeAll() {
    for (const [res, cleanup] of [...this.open]) {
      cleanup();
      res.end();
    }
  }

  private synthetic(type: 'heartbeat' | 'stream.reset', position: number, payload: unknown): DomainEvent {
    return {
      contractVersion: CONTRACT_VERSION,
      eventId: String(position),
      type,
      occurredAt: this.clock.iso(),
      jobId: null,
      watchId: null,
      payload,
    };
  }
}

function parseFilter(query: RouteInput<'streamEvents'>['query']): EventFilter {
  const types = query.types
    ?.split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const invalid = types?.filter((t) => !EventType.safeParse(t).success) ?? [];
  if (invalid.length) {
    throw AppError.invalid('Unknown event type', invalid.map((t) => ({ path: 'query.types', message: `Unknown event type ${t}` })));
  }
  return {
    jobId: query.jobId || undefined,
    watchId: query.watchId || undefined,
    types: types?.length ? (types as EventType[]) : undefined,
  };
}

/** Last-Event-ID takes precedence over ?after=. Null means "start at the current end". */
function parseCursor(header: string | string[] | undefined, after: string | undefined): number | null {
  const raw = (typeof header === 'string' && header.trim() !== '' ? header : after)?.trim();
  if (raw === undefined || raw === '') return null;
  if (!/^\d{1,15}$/.test(raw)) {
    throw AppError.invalid('Invalid event cursor', [{ path: 'Last-Event-ID', message: 'Expected a numeric event id' }]);
  }
  return Number(raw);
}
