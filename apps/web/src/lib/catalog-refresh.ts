'use client';

import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { TERMINAL_JOB_STATES } from '@domain-scout/contracts';
import { ApiRequestError, api } from './api';
import { qk } from './queries';







const CHANNEL = 'domain-scout:prices';
const FAST_POLL_MS = 1500;
const SLOW_POLL_MS = 15_000;

const FAST_FOR_MS = 60_000;
const followed = new Set<string>();






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

      if (error instanceof ApiRequestError && error.status < 500) {
        followed.delete(jobId);
        return;
      }
    }
    setTimeout(tick, Date.now() - startedAt < FAST_FOR_MS ? FAST_POLL_MS : SLOW_POLL_MS);
  };
  setTimeout(tick, FAST_POLL_MS);
}


export function usePriceAnnouncements() {
  const client = useQueryClient();
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => invalidatePrices(client);
    return () => channel.close();
  }, [client]);
}
