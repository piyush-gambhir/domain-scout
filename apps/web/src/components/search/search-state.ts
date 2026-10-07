'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_SETTINGS } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { qk, usePatchSettings, useSettings } from '@/lib/queries';
import { useDebounced } from '@/lib/use-debounced';
import { useIdempotency } from '@/lib/use-idempotency';
import { hashString } from '@/lib/utils';

export type Format = 'auto' | 'lines' | 'csv';
export type SearchMode = 'names' | 'ideas';

/** Advanced choices behind "Options". Defaults mean: detect the format, reuse recent results, label automatically. */
export interface SearchOptions {
  format: Format;
  csvColumn: string;
  recheck: boolean;
  label: string;
}

export const DEFAULT_OPTIONS: SearchOptions = { format: 'auto', csvColumn: '', recheck: false, label: '' };

export function optionsChanged(options: SearchOptions): number {
  return [options.format !== 'auto', options.recheck, options.label.trim() !== ''].filter(Boolean).length;
}

export const FALLBACK_EXTENSIONS = DEFAULT_SETTINGS.search.defaultExtensions;

/**
 * The remembered extension set (settings.search.defaultExtensions), shared with the CLI. `remember`
 * saves a user's change after a short pause so quick edits make one request.
 */
export function useDefaultExtensions() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const pending = useRef<string[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutate = patch.mutate;
  const remember = useCallback(
    (extensions: string[]) => {
      if (extensions.length === 0) return;
      pending.current = extensions.slice(0, 50);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const next = pending.current;
        pending.current = null;
        if (next) mutate({ search: { defaultExtensions: next } });
      }, 600);
    },
    [mutate],
  );
  useEffect(
    () => () => {
      // Leaving the page still saves the last change.
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) mutate({ search: { defaultExtensions: pending.current } });
    },
    [mutate],
  );
  return { value: settings.data?.search.defaultExtensions ?? null, loaded: settings.isSuccess || settings.isError, remember };
}

/** A readable label for History when the user gives none: the names typed, or the file name. */
export function autoLabel(text: string, fileName: string | null): string | undefined {
  if (fileName) return fileName.slice(0, 200);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  if (lines.length > 1) {
    const first = lines[0]!.split(/[\s,;]+/)[0] ?? lines[0]!;
    return `${first} and ${lines.length - 1} more`.slice(0, 200);
  }
  const tokens = lines[0]!.split(/[\s,;]+/).filter(Boolean);
  const head = tokens.slice(0, 5).join(' ');
  return (tokens.length > 5 ? `${head} and ${tokens.length - 5} more` : head).slice(0, 200);
}

/** Local parse of what a search would check. Nothing leaves the machine. */
export function useInputPreview(text: string, options: SearchOptions, extensions: string[], enabled = true) {
  const request = useMemo(
    () => ({ text, format: options.format, csvColumn: options.format === 'csv' ? options.csvColumn.trim() : '', extensions }),
    [text, options.format, options.csvColumn, extensions],
  );
  const debounced = useDebounced(request, 200);
  const has = enabled && debounced.text.trim().length > 0;
  const query = useQuery({
    queryKey: ['inputPreview', hashString(debounced.text), debounced.format, debounced.csvColumn, debounced.extensions],
    queryFn: ({ signal }) =>
      api
        .call('previewInput', {
          body: { text: debounced.text, format: debounced.format, csvColumn: debounced.format === 'csv' && debounced.csvColumn ? debounced.csvColumn : undefined, extensions: debounced.extensions },
          signal,
        })
        .then((r) => r.data),
    enabled: has,
    placeholderData: (previous) => previous,
    staleTime: Infinity,
    retry: false,
  });
  const settled = has && debounced === request && !query.isPlaceholderData;
  return { ...query, current: settled ? query.data : undefined, stale: !settled, has };
}

export interface SubmitInput {
  text: string;
  extensions: string[];
  options: SearchOptions;
  fileName: string | null;
  /** Query string for the results view, e.g. a restored filter. */
  resultsQuery?: string;
}

/** Starts a registry search and opens its results. */
export function useSubmitSearch() {
  const router = useRouter();
  const client = useQueryClient();
  const idempotency = useIdempotency();
  const mutation = useMutation({
    mutationFn: async (input: SubmitInput) => {
      const body = {
        type: 'registry_scan' as const,
        label: input.options.label.trim() || autoLabel(input.text, input.fileName),
        input: {
          text: input.text,
          format: input.options.format,
          csvColumn: input.options.format === 'csv' && input.options.csvColumn.trim() ? input.options.csvColumn.trim() : undefined,
          extensions: input.extensions,
        },
        recheck: input.options.recheck,
      };
      const job = (await api.call('createJob', { body, idempotencyKey: idempotency.keyFor(body) })).data;
      // The create response omits the input text; keep what was typed so the results bar shows it.
      const withText = { ...job, input: { ...job.input, text: job.input.text ?? input.text, format: job.input.format ?? body.input.format, csvColumn: job.input.csvColumn ?? body.input.csvColumn ?? null } };
      return { job: withText, resultsQuery: input.resultsQuery ?? '' };
    },
    onSuccess: ({ job, resultsQuery }) => {
      idempotency.reset();
      client.setQueryData(qk.job(job.id), job);
      void client.invalidateQueries({ queryKey: qk.jobs() });
      void client.invalidateQueries({ queryKey: qk.history() });
      router.push(`/search/${job.id}${resultsQuery}`);
    },
  });
  return mutation;
}

const TEXT_TYPES = /\.(txt|csv|tsv|list)$/i;
export const MAX_TEXT = 5_000_000;

/** Reads a dropped or chosen file as search text. CSV files switch the format to CSV. */
export async function readSearchFile(file: File): Promise<{ text: string; format: Format; fileName: string } | { error: string }> {
  if (file.size > MAX_TEXT) return { error: 'That file is larger than 5 MB.' };
  if (!TEXT_TYPES.test(file.name) && !file.type.startsWith('text/')) return { error: 'Use a TXT or CSV file.' };
  const text = await file.text();
  return { text, format: /\.(csv|tsv)$/i.test(file.name) ? 'csv' : 'auto', fileName: file.name };
}
