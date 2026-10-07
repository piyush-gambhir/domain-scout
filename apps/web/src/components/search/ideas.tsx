'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import type { GenerationRequest, GenerationStrategy } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { formatCount, plural } from '@/lib/format';
import { qk } from '@/lib/queries';
import { useDebounced } from '@/lib/use-debounced';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState } from '../states';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Field } from '../ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Skeleton } from '../ui/skeleton';
import { Switch } from '../ui/switch';
import { type Candidate, STRATEGY_LABEL, expandedDomains, fromGenerated, parseList } from './candidates';
import { OptionsTrigger } from './search-field';

export const STRATEGIES: { value: GenerationStrategy; label: string }[] = [
  { value: 'roots', label: 'Roots' },
  { value: 'affixes', label: 'Prefixes and suffixes' },
  { value: 'compounds', label: 'Compounds' },
  { value: 'syllables', label: 'Syllables' },
  { value: 'mutations', label: 'Variations' },
  { value: 'hacks', label: 'Domain hacks' },
];

/** Generation rules behind the Ideas options. Generation runs locally; nothing is sent anywhere. */
export interface IdeaRules {
  themes: string[];
  prefixes: string;
  suffixes: string;
  strategies: GenerationStrategy[];
  minLength: string;
  maxLength: string;
  allowDigits: boolean;
  allowHyphens: boolean;
  exclude: string;
  limit: string;
  seed: string;
}

/** Common brand affixes so a couple of keywords already yield a useful list; editable in Options. */
export const DEFAULT_RULES: IdeaRules = {
  themes: [],
  prefixes: 'get, try, use, go, my, hey',
  suffixes: 'hq, app, labs, hub, kit, ly, ify, now',
  strategies: ['roots', 'affixes', 'compounds', 'mutations'],
  minLength: '3',
  maxLength: '15',
  allowDigits: false,
  allowHyphens: false,
  exclude: '',
  limit: '300',
  seed: '',
};

export function rulesFromRequest(request: GenerationRequest): IdeaRules {
  const rules = request.rules;
  return {
    themes: request.themes ?? [],
    prefixes: (request.prefixes ?? []).join(', '),
    suffixes: (request.suffixes ?? []).join(', '),
    strategies: request.strategies ?? DEFAULT_RULES.strategies,
    minLength: String(rules?.minLength ?? 3),
    maxLength: String(rules?.maxLength ?? 15),
    allowDigits: rules?.allowDigits ?? false,
    allowHyphens: rules?.allowHyphens ?? false,
    exclude: (rules?.exclude ?? []).join(', '),
    limit: String(request.limit ?? 300),
    seed: request.seed === undefined ? '' : String(request.seed),
  };
}

function intIn(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/** The generation request for these keywords and rules, or null while a rule is invalid. */
export function buildGeneration(keywords: string, rules: IdeaRules, extensions: string[]): GenerationRequest | null {
  const roots = parseList(keywords).filter((r) => r.length <= 63).slice(0, 200);
  const minLength = intIn(rules.minLength, 1, 63);
  const maxLength = intIn(rules.maxLength, 1, 63);
  const limit = intIn(rules.limit, 1, 5000);
  const seed = rules.seed.trim();
  if (minLength === null || maxLength === null || minLength > maxLength || limit === null || rules.strategies.length === 0) return null;
  if (seed && !/^-?\d+$/.test(seed)) return null;
  return {
    roots,
    themes: rules.themes,
    prefixes: parseList(rules.prefixes).filter((p) => p.length <= 30).slice(0, 200),
    suffixes: parseList(rules.suffixes).filter((p) => p.length <= 30).slice(0, 200),
    strategies: rules.strategies,
    rules: { minLength, maxLength, allowDigits: rules.allowDigits, allowHyphens: rules.allowHyphens, exclude: parseList(rules.exclude).slice(0, 500) },
    extensions,
    limit,
    seed: seed ? Number(seed) : undefined,
  };
}

export function hasSource(request: GenerationRequest | null): boolean {
  if (!request) return false;
  return (request.roots?.length ?? 0) > 0 || (request.themes?.length ?? 0) > 0 || (request.strategies ?? []).includes('syllables');
}

const toggleClass =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-[pressed=false]:bg-input aria-[pressed=false]:hover:bg-selected';

function Themes({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const themes = useQuery({
    queryKey: qk.generationThemes,
    queryFn: ({ signal }) => api.call('listGenerationThemes', { signal }).then((r) => r.data),
    staleTime: Infinity,
  });
  if (themes.isPending) return <Skeleton className="h-7 w-48" />;
  if (themes.isError || themes.data.length === 0) return <p className="text-xs text-muted-foreground">No themes bundled.</p>;
  const selected = new Set(value);
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Themes">
      {themes.data.map((theme) => (
        <button
          key={theme.id}
          type="button"
          aria-pressed={selected.has(theme.id)}
          title={theme.sample.join(', ')}
          onClick={() => onChange(selected.has(theme.id) ? value.filter((t) => t !== theme.id) : [...value, theme.id].slice(0, 20))}
          className={toggleClass}
        >
          {theme.name}
          <span className="text-xs opacity-60 tabular">{theme.size}</span>
        </button>
      ))}
    </div>
  );
}

/** Themes, strategies and rules for name ideas. */
export function IdeasOptionsPopover({ value, onChange }: { value: IdeaRules; onChange: (next: IdeaRules) => void }) {
  const set = (patch: Partial<IdeaRules>) => onChange({ ...value, ...patch });
  const changed = JSON.stringify(value) !== JSON.stringify(DEFAULT_RULES) ? 1 : 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <OptionsTrigger changed={changed} />
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-[26rem] flex-col gap-4 p-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Themes</span>
          <Themes value={value.themes} onChange={(themes) => set({ themes })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground" id="ideas-strategies">
            Strategies
          </span>
          <div className="flex flex-wrap gap-1" role="group" aria-labelledby="ideas-strategies">
            {STRATEGIES.map((strategy) => {
              const on = value.strategies.includes(strategy.value);
              return (
                <button
                  key={strategy.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set({ strategies: on ? value.strategies.filter((s) => s !== strategy.value) : [...value.strategies, strategy.value] })}
                  className={toggleClass}
                >
                  {strategy.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Prefixes" htmlFor="ideas-prefixes">
            <Input id="ideas-prefixes" value={value.prefixes} spellCheck={false} onChange={(e) => set({ prefixes: e.target.value })} className="font-mono" />
          </Field>
          <Field label="Suffixes" htmlFor="ideas-suffixes">
            <Input id="ideas-suffixes" value={value.suffixes} spellCheck={false} onChange={(e) => set({ suffixes: e.target.value })} className="font-mono" />
          </Field>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <Field label="Min length" htmlFor="ideas-min">
            <Input id="ideas-min" inputMode="numeric" value={value.minLength} onChange={(e) => set({ minLength: e.target.value })} className="font-mono" />
          </Field>
          <Field label="Max length" htmlFor="ideas-max">
            <Input id="ideas-max" inputMode="numeric" value={value.maxLength} onChange={(e) => set({ maxLength: e.target.value })} className="font-mono" />
          </Field>
          <Field label="Limit" htmlFor="ideas-limit">
            <Input id="ideas-limit" inputMode="numeric" value={value.limit} onChange={(e) => set({ limit: e.target.value })} className="font-mono" />
          </Field>
          <Field label="Seed" htmlFor="ideas-seed">
            <Input id="ideas-seed" inputMode="numeric" placeholder="1" value={value.seed} onChange={(e) => set({ seed: e.target.value })} className="font-mono" />
          </Field>
        </div>
        <Field label="Exclude" htmlFor="ideas-exclude">
          <Input id="ideas-exclude" value={value.exclude} spellCheck={false} onChange={(e) => set({ exclude: e.target.value })} className="font-mono" />
        </Field>
        <div className="flex items-center gap-5">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={value.allowDigits} onCheckedChange={(allowDigits) => set({ allowDigits })} aria-label="Allow digits" />
            Digits
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={value.allowHyphens} onCheckedChange={(allowHyphens) => set({ allowHyphens })} aria-label="Allow hyphens" />
            Hyphens
          </label>
          <Button size="sm" variant="quiet" className="ml-auto" onClick={() => onChange(DEFAULT_RULES)}>
            Reset
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function IdeaRow({ candidate, selected, onToggle }: { candidate: Candidate; selected: boolean; onToggle: () => void }) {
  const id = `idea-${candidate.key}`;
  return (
    <li>
      <label
        htmlFor={id}
        className={cn(
          'grid h-9 cursor-pointer grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 text-sm transition-colors hover:bg-hover',
          selected && 'bg-selected hover:bg-selected',
          !candidate.valid && 'cursor-not-allowed text-muted-foreground',
        )}
      >
        <Checkbox id={id} checked={selected} disabled={!candidate.valid} onCheckedChange={onToggle} aria-label={`Select ${candidate.key}`} />
        <span className="min-w-0 truncate font-medium" title={candidate.rule}>
          {candidate.key}
        </span>
        <span className="truncate text-xs text-muted-foreground">{candidate.valid ? STRATEGY_LABEL[candidate.strategy] : candidate.issues.join('; ')}</span>
      </label>
    </li>
  );
}

/**
 * Local name suggestions for the keywords, as a list to pick from. Picking sends nothing; "Check"
 * starts a registry search of the picked names across the chosen extensions.
 */
export function IdeasPanel({
  keywords,
  rules,
  extensions,
  onCheck,
  pending,
  footer,
  initialSelected,
}: {
  /** Picks restored from a saved search, applied once the ideas first load. */
  initialSelected?: string[];
  keywords: string;
  rules: IdeaRules;
  extensions: string[];
  onCheck: (names: string[], request: GenerationRequest | null) => void;
  pending: boolean;
  /** Extra actions beside Check, e.g. saving the ideas as a search. */
  footer?: (selected: string[], request: GenerationRequest | null) => React.ReactNode;
}) {
  const request = useMemo(() => buildGeneration(keywords, rules, extensions), [keywords, rules, extensions]);
  const key = JSON.stringify(request);
  const debouncedKey = useDebounced(key, 250);
  const debounced = useMemo(() => JSON.parse(debouncedKey) as GenerationRequest | null, [debouncedKey]);
  const enabled = hasSource(debounced);
  const preview = useQuery({
    queryKey: ['generationPreview', debouncedKey],
    queryFn: ({ signal }) => api.call('previewGeneration', { body: debounced!, signal }).then((r) => r.data),
    enabled,
    placeholderData: (previous) => previous,
    staleTime: Infinity,
    retry: false,
  });
  const candidates = useMemo(
    () => (enabled ? (preview.data?.candidates ?? []).map(fromGenerated).sort((a, b) => Number(b.valid) - Number(a.valid)) : []),
    [enabled, preview.data],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const restore = useRef(initialSelected);
  // Picks survive regeneration only for names still suggested.
  useEffect(() => {
    const keys = new Set(candidates.map((c) => c.key));
    if (restore.current && candidates.length) {
      const wanted = restore.current;
      restore.current = undefined;
      setSelected(new Set(wanted.filter((k) => keys.has(k))));
      return;
    }
    setSelected((current) => {
      const next = new Set([...current].filter((k) => keys.has(k)));
      return next.size === current.size ? current : next;
    });
  }, [candidates]);

  const picked = candidates.filter((c) => c.valid && selected.has(c.key));
  const checks = expandedDomains(picked, extensions);
  const valid = candidates.filter((c) => c.valid);
  const allSelected = valid.length > 0 && valid.every((c) => selected.has(c.key));
  const busy = enabled && (preview.isFetching || debouncedKey !== key);

  if (!hasSource(request)) {
    return <EmptyState className="flex-none py-10">Type a few keywords to get name ideas.</EmptyState>;
  }

  return (
    <section aria-label="Name ideas" aria-busy={busy} className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-2">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            aria-label="Select every idea"
            checked={allSelected ? true : selected.size ? 'indeterminate' : false}
            onCheckedChange={(v) => setSelected(v === true ? new Set(valid.map((c) => c.key)) : new Set())}
          />
          <span data-testid="ideas-count">{plural(candidates.length, 'idea')}</span>
        </label>
        <span className="text-sm text-muted-foreground" data-testid="ideas-selection">
          {picked.length ? (
            <>
              <span className="font-medium text-foreground tabular">{formatCount(picked.length)}</span> picked · {plural(checks, 'check')}
            </>
          ) : null}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {footer?.(picked.map((c) => c.key), request)}
          <Button size="sm" variant="primary" disabled={picked.length === 0 || pending || extensions.length === 0} onClick={() => onCheck(picked.map((c) => c.key), request)}>
            Check {picked.length ? formatCount(picked.length) : 'selected'}
            <ArrowRight />
          </Button>
        </div>
      </div>
      {preview.isError ? <ErrorState error={preview.error} onRetry={() => preview.refetch()} /> : null}
      <div className={cn('relative -mx-1 min-h-0 flex-1 overflow-y-auto px-1 transition-opacity', busy && 'opacity-60')}>
        {candidates.length === 0 && !busy ? (
          <EmptyState>No ideas for these keywords.</EmptyState>
        ) : (
          <ul aria-label="Ideas" className="grid grid-cols-1 gap-x-2 sm:grid-cols-2 xl:grid-cols-3">
            {candidates.map((candidate) => (
              <IdeaRow
                key={candidate.key}
                candidate={candidate}
                selected={selected.has(candidate.key)}
                onToggle={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(candidate.key)) next.delete(candidate.key);
                    else next.add(candidate.key);
                    return next;
                  })
                }
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
