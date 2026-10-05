import { Injectable } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PublishedLimit } from './data.js';

/** Longest wait for a published-limit slot inside one job item; longer waits become rate_limited with retryAt. */
export const MAX_PACING_WAIT_MS = 60_000;

/**
 * Keeps registry queries within a registry's published per-IP limits (for example 100 WHOIS queries
 * per rolling 24 hours for .ie, or one query per 10 s for .hk), which can be far below the engine's
 * default pace. Starts are counted per registryId and per backend process: a restart begins a fresh
 * window, so the limits hold within one run, not across restarts.
 */
@Injectable()
export class PublishedLimits {
  private readonly starts = new Map<string, number[]>();

  /**
   * Reserves the earliest start that keeps every limit when it is at most MAX_PACING_WAIT_MS away
   * (`waitMs`), otherwise reserves nothing and returns when the next start would be allowed.
   */
  reserve(registryId: string, limits: PublishedLimit[], now: Date): { waitMs: number } | { retryAt: string } {
    const t = now.getTime();
    const longest = Math.max(...limits.map((limit) => limit.windowSeconds)) * 1000;
    const starts = (this.starts.get(registryId) ?? []).filter((start) => start > t - longest);
    this.starts.set(registryId, starts);
    // Starts stay in ascending order: a window is full when its queries-th most recent start is inside it.
    let at = Math.max(t, starts.at(-1) ?? t);
    for (const limit of limits) {
      const oldestCounted = starts[starts.length - limit.queries];
      if (oldestCounted !== undefined) at = Math.max(at, oldestCounted + limit.windowSeconds * 1000);
    }
    if (at - t > MAX_PACING_WAIT_MS) return { retryAt: new Date(at).toISOString() };
    starts.push(at);
    return { waitMs: at - t };
  }

  /** Waits for a reserved slot; rejects when the job is cancelled. Tests replace it. */
  async wait(ms: number, signal: AbortSignal): Promise<void> {
    if (ms > 0) await sleep(ms, undefined, { signal });
  }
}
