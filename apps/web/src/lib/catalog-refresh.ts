'use client';

import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { TERMINAL_JOB_STATES } from '@domain-scout/contracts';
import { ApiRequestError, api } from './api';
import { qk } from './queries';

/*
 * `catalog.updated` events carry no job id, so the job-scoped streams pages hold never see them,
 * and price queries otherwise stay cached for five minutes. The tab that starts a catalog refresh
 * follows the job until it ends, then drops cached prices here and in every other open tab.
 */

const CHANNEL = 'domain-scout:prices';
const FAST_POLL_MS = 1500;
const SLOW_POLL_MS = 15_000;
/** Most refreshes finish within this; one waiting on a provider cooldown is polled slowly until it ends. */
const FAST_FOR_MS = 60_000;
const followed = new Set<string>();

/**
 * Refetches everything derived from published prices: suffix prices, result rows and recheck
 * overlays (their best price wins over suffix prices), domain evidence, shortlists, comparisons,
 * price history, owned-domain alternatives and provider catalogs.
 */
export function invalidatePrices(client: QueryClient) {
  for (const queryKey of [['prices'], ['jobResults'], ['recheckOverlay'], ['evidence'], ['collectionEntries'], ['comparison'], ['priceHistory'], ['transferOptions'], qk.portfolio, qk.providers]) {
    void client.invalidateQueries({ queryKey });
  }
}

function announce() {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage('catalog.updated');
  channel.close();
}

/**
 * Polls a catalog refresh job until it ends, however long a provider cooldown delays it, then
 * refreshes prices in this tab and announces it to the others. Lives outside React so leaving
 * Settings does not stop it; closing the tab does.
 */
export function followCatalogRefresh(client: QueryClient, jobId: string) {
  if (followed.has(jobId)) return;
  followed.add(jobId);
  const startedAt = Date.now();
  const tick = async () => {
    try {
      const job = (await api.call('getJob', { params: { id: jobId } })).data;
      client.setQueryData(qk.job(jobId), job);
      if (TERMINAL_JOB_STATES.includes(job.state)) {
        followed.delete(jobId);
        invalidatePrices(client);
        announce();
        return;
      }
    } catch (error) {
      // A deleted job or an expired session will not recover by polling.
      if (error instanceof ApiRequestError && error.status < 500) {
        followed.delete(jobId);
        return;
      }
    }
    setTimeout(tick, Date.now() - startedAt < FAST_FOR_MS ? FAST_POLL_MS : SLOW_POLL_MS);
  };
  setTimeout(tick, FAST_POLL_MS);
}

/** Refreshes prices in this tab when another tab finishes a catalog refresh. */
export function usePriceAnnouncements() {
  const client = useQueryClient();
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => invalidatePrices(client);
    return () => channel.close();
  }, [client]);
}
