'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import type { GenerationRequest, InputPreviewRow, ResultFilter } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { PROVIDERS_PARAM, compactFilter, withBudget, withoutPrice } from '@/lib/criteria';
import { qk } from '@/lib/queries';
import { readJson, writeJson } from '@/lib/storage';
import { uniq } from '@/lib/utils';
import { useIsClient } from '@/lib/use-is-client';
import { SaveCriteriaPopover } from '../actions/save-criteria';
import { filterToParams } from '../jobs/filters';
import { Page } from '../states';
import { Skeleton } from '../ui/skeleton';
import { ExtensionChips } from './extension-chips';
import { DEFAULT_RULES, IdeasOptionsPopover, IdeasPanel, type IdeaRules, rulesFromRequest } from './ideas';
import { PreviewLine, ProblemRows } from './preview-line';
import { RecentSearches } from './recent-searches';
import { SearchField } from './search-field';
import { SearchOptionsPopover } from './search-options';
import {
  DEFAULT_OPTIONS,
  FALLBACK_EXTENSIONS,
  MAX_TEXT,
  type SearchMode,
  type SearchOptions,
  useDefaultExtensions,
  useInputPreview,
  useSubmitSearch,
} from './search-state';

/** What the home keeps across navigation within a browser session. */
interface Draft {
  text: string;
  keywords: string;
  mode: SearchMode;
  options: SearchOptions;
  rules: IdeaRules;
  fileName: string | null;
}

const DRAFT_KEY = 'ds.search.draft';
const EMPTY: Draft = { text: '', keywords: '', mode: 'names', options: DEFAULT_OPTIONS, rules: DEFAULT_RULES, fileName: null };

/** A restored saved search: its results filter and the ideas it had picked. */
interface Restored {
  name: string;
  resultsQuery: string;
  selection: string[] | null;
}

function initialDraft(params: URLSearchParams): Draft {
  const stored = readJson<Partial<Draft>>('session', DRAFT_KEY);
  const base: Draft = stored ? { ...EMPTY, ...stored, options: { ...DEFAULT_OPTIONS, ...stored.options }, rules: { ...DEFAULT_RULES, ...stored.rules } } : EMPTY;
  const mode = params.get('mode') === 'ideas' ? 'ideas' : params.has('q') ? 'names' : base.mode;
  const q = params.get('q');
  return {
    ...base,
    mode,
    ...(q !== null ? (mode === 'ideas' ? { keywords: q } : { text: q, fileName: null }) : {}),
  };
}

function HomeSkeleton() {
  return (
    <Page className="items-center">
      <div className="w-full max-w-3xl pt-[clamp(2rem,16vh,10rem)]">
        <Skeleton className="h-13 w-full rounded-xl" />
        <Skeleton className="mt-3 h-8 w-80" />
      </div>
    </Page>
  );
}

function SearchHomeInner() {
  const params = useSearchParams();
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(new URLSearchParams(params.toString())));
  const defaults = useDefaultExtensions();
  // Null until the remembered set loads (or a restore sets it); chips then show the user's set.
  const [extensions, setExtensionsState] = useState<string[] | null>(null);
  const [restored, setRestored] = useState<Restored | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const submit = useSubmitSearch();
  const shownExtensions = extensions ?? defaults.value ?? (defaults.loaded ? FALLBACK_EXTENSIONS : []);
  // Bumped by every user edit, so a slow restore never overwrites what was typed meanwhile.
  const editVersion = useRef(0);
  const update = (patch: Partial<Draft>) => {
    editVersion.current += 1;
    setDraft((d) => ({ ...d, ...patch }));
  };
  const setExtensions = (next: string[]) => {
    editVersion.current += 1;
    setExtensionsState(next);
    defaults.remember(next);
  };

  // Links to the home while it is open (the palette's "Name ideas", Ideas from results) switch mode.
  // Adjusted during render, like derived state, so the first paint already shows the mode.
  const linkKey = `${params.get('mode')}|${params.get('q')}`;
  const [seenLink, setSeenLink] = useState(linkKey);
  if (seenLink !== linkKey) {
    setSeenLink(linkKey);
    const mode = params.get('mode');
    const q = params.get('q');
    if (mode === 'ideas' || q !== null) {
      const ideas = mode === 'ideas';
      setDraft((d) => ({ ...d, mode: ideas ? 'ideas' : 'names', ...(q !== null ? (ideas ? { keywords: q } : { text: q, fileName: null }) : {}) }));
    }
  }

  // Restore sources run once and leave the URL: ?job= (a past search), ?criteria= (a saved search).
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const job = params.get('job');
    const criteria = params.get('criteria');
    const source = job ? `job:${job}` : criteria ? `criteria:${criteria}` : null;
    if (params.has('mode') || params.has('q') || source) window.history.replaceState(null, '', '/');
    if (!source || handled.current === source) return;
    handled.current = source;
    const startedAt = editVersion.current;
    const current = () => handled.current === source && editVersion.current === startedAt;
    if (job) {
      api
        .call('getJob', { params: { id: job } })
        .then(({ data }) => {
          if (!current()) return;
          setDraft((d) => ({
            ...d,
            mode: 'names',
            text: data.input.text ?? '',
            fileName: null,
            options: { ...DEFAULT_OPTIONS, format: data.input.format ?? 'auto', csvColumn: data.input.csvColumn ?? '', label: data.label ?? '' },
          }));
          setExtensionsState(data.input.extensions);
        })
        .catch(() => toast.error('Could not restore that search.'));
    } else if (criteria) {
      api
        .call('getCriteria', { params: { id: criteria } })
        .then(({ data }) => {
          if (!current()) return;
          const filter = compactFilter(data.filter);
          const budget = data.budget ?? (filter.maxPrice ? { amount: filter.maxPrice, currency: filter.priceCurrency ?? 'USD' } : null);
          const query = filterToParams(compactFilter(withBudget(withoutPrice(filter) as ResultFilter, budget)), new URLSearchParams());
          if (data.providerIds.length) query.set(PROVIDERS_PARAM, data.providerIds.join(','));
          const lines = (data.input ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          if (data.extensions.length) setExtensionsState(data.extensions);
          if (data.generation) {
            const generation = data.generation as GenerationRequest;
            setDraft((d) => ({ ...d, mode: 'ideas', keywords: (generation.roots ?? []).join(' '), rules: rulesFromRequest(generation) }));
            setRestored({ name: data.name, resultsQuery: query.toString() ? `?${query.toString()}` : '', selection: data.input === null ? null : lines });
          } else {
            // Saved input is normalized names, one per line: never read it with an old draft's CSV options.
            setDraft((d) => ({ ...d, mode: 'names', text: data.input ?? '', fileName: null, options: { ...DEFAULT_OPTIONS, format: 'lines' } }));
            setRestored({ name: data.name, resultsQuery: query.toString() ? `?${query.toString()}` : '', selection: null });
          }
          toast.success(`Restored ${data.name}`);
        })
        .catch(() => toast.error('Could not restore that saved search.'));
    }
  }, [params]);

  useEffect(() => {
    const timer = setTimeout(() => writeJson('session', DRAFT_KEY, draft.text.length <= 1_000_000 ? draft : { ...draft, text: '', fileName: null }), 300);
    return () => clearTimeout(timer);
  }, [draft]);

  // "/" focuses the search bar from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const names = draft.mode === 'names';
  const tooLarge = draft.text.length > MAX_TEXT;
  const preview = useInputPreview(draft.text, draft.options, shownExtensions, names && !tooLarge);
  const checks = preview.current?.counts.totalChecks ?? 0;
  const canSubmit = names && checks > 0 && !tooLarge;
  const problems = useMemo(() => (preview.data?.rows ?? []).filter((r) => r.status === 'invalid' || r.status === 'ambiguous'), [preview.data]);

  const run = () => {
    if (!canSubmit) return;
    submit.mutate({ text: draft.text, extensions: shownExtensions, options: draft.options, fileName: draft.fileName, resultsQuery: restored?.resultsQuery });
  };
  const checkIdeas = (picked: string[]) =>
    submit.mutate({
      text: picked.join('\n'),
      extensions: shownExtensions,
      options: { ...DEFAULT_OPTIONS, format: 'lines', label: draft.options.label || `Ideas for ${draft.keywords.trim()}`.slice(0, 200) },
      fileName: null,
      resultsQuery: restored?.resultsQuery,
    });

  const useSuggestion = (row: InputPreviewRow) => {
    if (!row.suggestion || row.status !== 'ambiguous' || draft.options.format === 'csv') return undefined;
    return () => {
      const lines = draft.text.split(/\r?\n/);
      const index = row.row - 1;
      const line = lines[index];
      if (line === undefined || !line.includes(row.original.trim())) {
        toast.error('The input changed. Edit the name directly.');
        return;
      }
      lines[index] = line.replace(row.original.trim(), row.suggestion!);
      update({ text: lines.join('\n') });
    };
  };

  // Saved criteria keep text but not parse options, so CSV input saves the values of the column read.
  const criteriaInput =
    draft.options.format === 'csv' ? (preview.current ? uniq(preview.current.rows.map((r) => r.original.trim()).filter(Boolean)).join('\n') : null) : draft.text;
  const saveSearch = useMutation({
    mutationFn: async ({ name, picked, generation }: { name: string; picked?: string[]; generation?: GenerationRequest | null }) =>
      (
        await api.call('createCriteria', {
          body: names
            ? { name, input: criteriaInput ?? '', extensions: shownExtensions }
            : { name, input: (picked ?? []).join('\n'), extensions: shownExtensions, generation: generation ?? undefined },
        })
      ).data,
    onSuccess: (criteria) => {
      void client.invalidateQueries({ queryKey: qk.criteria });
      toast.success(`Saved ${criteria.name}`);
    },
  });

  const field = (
    <SearchField
      size="hero"
      inputRef={inputRef}
      autoFocus
      mode={draft.mode}
      onModeChange={(mode) => update({ mode, ...(mode === 'ideas' && !draft.keywords && draft.text && !draft.text.includes('\n') ? { keywords: draft.text } : {}) })}
      value={names ? draft.text : draft.keywords}
      onChange={(value) => (names ? update({ text: value, ...(draft.fileName && value === '' ? { fileName: null } : {}) }) : update({ keywords: value }))}
      onSubmit={run}
      canSubmit={canSubmit}
      pending={submit.isPending}
      onFile={(file) => update({ mode: 'names', text: file.text, fileName: file.fileName, options: { ...draft.options, format: file.format } })}
      fileName={names ? draft.fileName : null}
      onClearFile={() => update({ text: '', fileName: null, options: { ...draft.options, format: 'auto', csvColumn: '' } })}
      options={
        names ? (
          <SearchOptionsPopover
            value={draft.options}
            onChange={(options) => update({ options })}
            onSave={draft.text.trim() && !tooLarge && criteriaInput !== null ? (name) => saveSearch.mutateAsync({ name }) : undefined}
            saving={saveSearch.isPending}
          />
        ) : (
          <IdeasOptionsPopover value={draft.rules} onChange={(rules) => update({ rules })} />
        )
      }
    />
  );

  return (
    <Page className="items-center">
      <div className="flex w-full max-w-3xl flex-1 flex-col pt-[clamp(1.5rem,14vh,9rem)] lg:min-h-0">
        <h1 className="sr-only">Search</h1>
        {field}
        <div className="mt-2.5 flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 px-1">
          <ExtensionChips value={shownExtensions} onChange={setExtensions} />
          {names ? <PreviewLine preview={preview.current ?? preview.data} stale={preview.stale} has={preview.has} className="h-8" /> : null}
        </div>
        {tooLarge ? <p className="mt-2 px-1 text-xs text-negative">The list is larger than 5 MB.</p> : null}
        {names && shownExtensions.length === 0 ? <p className="mt-2 px-1 text-xs text-muted-foreground">Names without an extension need at least one extension.</p> : null}
        {restored ? (
          <p className="mt-2 flex items-center gap-2 px-1 text-xs text-muted-foreground" data-testid="restored-search">
            From saved search <span className="font-medium text-foreground">{restored.name}</span>
            <button type="button" aria-label="Clear saved search" onClick={() => setRestored(null)} className="grid size-5 place-items-center rounded hover:bg-hover hover:text-foreground">
              <X className="size-3" />
            </button>
          </p>
        ) : null}

        <div className="mt-6 flex min-h-0 flex-1 flex-col">
          {names ? (
            problems.length ? (
              <div className="relative -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
                <ProblemRows rows={problems} onUseSuggestion={useSuggestion} />
              </div>
            ) : draft.text.trim() ? null : (
              <div className="relative -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
                <RecentSearches />
              </div>
            )
          ) : (
            <IdeasPanel
              key={restored?.selection ? `restored-${restored.name}` : 'ideas'}
              keywords={draft.keywords}
              rules={draft.rules}
              extensions={shownExtensions}
              initialSelected={restored?.selection ?? undefined}
              pending={submit.isPending}
              onCheck={checkIdeas}
              footer={(picked, generation) => (
                <SaveCriteriaPopover
                  label="Save ideas"
                  disabled={!generation}
                  pending={saveSearch.isPending}
                  onSave={(name) => saveSearch.mutateAsync({ name, picked, generation })}
                />
              )}
            />
          )}
        </div>
      </div>
    </Page>
  );
}

/** The search form reads a session draft from browser storage, so it renders on the client only. */
export function SearchHome() {
  const isClient = useIsClient();
  if (!isClient) return <HomeSkeleton />;
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <SearchHomeInner />
    </Suspense>
  );
}
