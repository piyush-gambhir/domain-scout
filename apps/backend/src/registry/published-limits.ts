import { Injectable } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PublishedLimit } from './data.js';


export const MAX_PACING_WAIT_MS = 60_000;







@Injectable()
export class PublishedLimits {
  private readonly starts = new Map<string, number[]>();





  reserve(registryId: string, limits: PublishedLimit[], now: Date): { waitMs: number } | { retryAt: string } {
    const t = now.getTime();
    const longest = Math.max(...limits.map((limit) => limit.windowSeconds)) * 1000;
    const starts = (this.starts.get(registryId) ?? []).filter((start) => start > t - longest);
    this.starts.set(registryId, starts);

    let at = Math.max(t, starts.at(-1) ?? t);
    for (const limit of limits) {
      const oldestCounted = starts[starts.length - limit.queries];
      if (oldestCounted !== undefined) at = Math.max(at, oldestCounted + limit.windowSeconds * 1000);
    }
    if (at - t > MAX_PACING_WAIT_MS) return { retryAt: new Date(at).toISOString() };
    starts.push(at);
    return { waitMs: at - t };
  }


  async wait(ms: number, signal: AbortSignal): Promise<void> {
    if (ms > 0) await sleep(ms, undefined, { signal });
  }
}
