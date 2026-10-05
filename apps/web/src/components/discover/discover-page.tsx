'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Plus, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import type { GenerationPreview, GenerationRequest, GenerationStrategy } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { formatCount, plural } from '@/lib/format';
import { qk } from '@/lib/queries';
import { stashScanInput } from '@/lib/restore';
import { readJson, writeJson } from '@/lib/storage';
import { useDebounced } from '@/lib/use-debounced';
import { useIsClient } from '@/lib/use-is-client';
import { cn } from '@/lib/utils';
import { SaveCriteriaPopover } from '../actions/save-criteria';
import { ExtensionPicker } from '../scan/extension-picker';
import { EmptyState, ErrorState, PageHeader, SectionTitle } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input, Textarea } from '../ui/input';
import { Field } from '../ui/label';
import { Skeleton } from '../ui/skeleton';
import { Switch } from '../ui/switch';
import { type Candidate, STRATEGY_LABEL, addedCandidate, expandedDomains, fromGenerated, parseList } from './candidates';

const STRATEGIES: { value: GenerationStrategy; label: string }[] = [
  { value: 'roots', label: 'Roots' },
  { value: 'affixes', label: 'Prefixes and suffixes' },
  { value: 'compounds', label: 'Compounds' },
  { value: 'syllables', label: 'Syllables' },
  { value: 'mutations', label: 'Variations' },
  { value: 'hacks', label: 'Domain hacks' },
];

interface Form {
  roots: string;
  themes: string[];
  prefixes: string;
  suffixes: string;
  strategies: GenerationStrategy[];
  minLength: string;
  maxLength: string;
  allowDigits: boolean;
  allowHyphens: boolean;
  exclude: string;
  extensions: string[];
  limit: string;
  seed: string;
}

/** The form plus the user's edits to the generated list. Kept per browser session. */
interface Draft {
  form: Form;
  added: string[];
  removed: string[];
  excluded: string[];
}

const DRAFT_KEY = 'ds.discover.draft';
const PAGE = 200;

const EMPTY_FORM: Form = {
  roots: '',
  themes: [],
  prefixes: '',
  suffixes: '',
  strategies: ['roots', 'affixes', 'compounds'],
  minLength: '3',
  maxLength: '15',
  allowDigits: false,
  allowHyphens: false,
  exclude: '',
  extensions: [],
  limit: '300',
  seed: '',
};
const EMPTY_DRAFT: Draft = { form: EMPTY_FORM, added: [], removed: [], excluded: [] };

function formFromRequest(request: GenerationRequest, extensions: string[]): Form {
  const rules = request.rules;
  return {
    roots: (request.roots ?? []).join('\n'),
    themes: request.themes ?? [],
    prefixes: (request.prefixes ?? []).join(', '),
    suffixes: (request.suffixes ?? []).join(', '),
    strategies: request.strategies ?? EMPTY_FORM.strategies,
    minLength: String(rules?.minLength ?? 3),
    maxLength: String(rules?.maxLength ?? 15),
    allowDigits: rules?.allowDigits ?? false,
    allowHyphens: rules?.allowHyphens ?? false,
    exclude: (rules?.exclude ?? []).join(', '),
    extensions: extensions.length ? extensions : (request.extensions ?? []),
    limit: String(request.limit ?? 300),
    seed: request.seed === undefined ? '' : String(request.seed),
  };
}

type Errors = Partial<Record<keyof Form, string>>;

function intIn(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/** Builds the API request, or field errors. Nothing here leaves the browser. */
function buildRequest(form: Form): { request: GenerationRequest | null; errors: Errors } {
  const errors: Errors = {};
  const roots = parseList(form.roots);
  const prefixes = parseList(form.prefixes);
  const suffixes = parseList(form.suffixes);
  const exclude = parseList(form.exclude);
  if (roots.length > 200) errors.roots = 'At most 200 roots.';
  else if (roots.some((r) => r.length > 63)) errors.roots = 'Roots are at most 63 characters.';
  if (prefixes.length > 200 || prefixes.some((p) => p.length > 30)) errors.prefixes = 'At most 200 prefixes of 30 characters.';
  if (suffixes.length > 200 || suffixes.some((s) => s.length > 30)) errors.suffixes = 'At most 200 suffixes of 30 characters.';
  if (exclude.length > 500 || exclude.some((e) => e.length > 63)) errors.exclude = 'At most 500 entries of 63 characters.';
  const minLength = intIn(form.minLength, 1, 63);
  const maxLength = intIn(form.maxLength, 1, 63);
  if (minLength === null) errors.minLength = 'Between 1 and 63.';
  if (maxLength === null) errors.maxLength = 'Between 1 and 63.';
  if (minLength !== null && maxLength !== null && minLength > maxLength) errors.maxLength = 'At least the minimum.';
  const limit = intIn(form.limit, 1, 5000);
  if (limit === null) errors.limit = 'Between 1 and 5,000.';
  const seedText = form.seed.trim();
  if (seedText && !/^-?\d+$/.test(seedText)) errors.seed = 'A whole number.';
  if (form.strategies.length === 0) errors.strategies = 'Choose at least one.';
  if (Object.keys(errors).length > 0 || minLength === null || maxLength === null || limit === null) return { request: null, errors };
  return {
    request: {
      roots,
      themes: form.themes,
      prefixes,
      suffixes,
      strategies: form.strategies,
      rules: { minLength, maxLength, allowDigits: form.allowDigits, allowHyphens: form.allowHyphens, exclude },
      extensions: form.extensions,
      limit,
      seed: seedText ? Number(seedText) : undefined,
    },
    errors,
  };
}

function fieldError(message: string | undefined) {
  return message ? <span className="text-negative">{message}</span> : undefined;
}

function hasSource(request: GenerationRequest): boolean {
  return (request.roots?.length ?? 0) > 0 || (request.themes?.length ?? 0) > 0 || (request.strategies ?? []).includes('syllables');
}

function Stat({ label, value, testId, emphasis }: { label: string; value: number | undefined; testId: string; emphasis?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className={cn('font-mono text-lg tabular', emphasis && 'font-semibold')}>
        {value === undefined ? '0' : formatCount(value)}
      </dd>
    </div>
  );
}

const toggleClass =
  'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-[pressed=false]:bg-input aria-[pressed=false]:hover:bg-selected';

function Toggle({ pressed, onClick, children, title }: { pressed: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button type="button" aria-pressed={pressed} title={title} onClick={onClick} className={toggleClass}>
      {children}
    </button>
  );
}

function ThemePicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const themes = useQuery({
    queryKey: qk.generationThemes,
    queryFn: ({ signal }) => api.call('listGenerationThemes', { signal }).then((r) => r.data),
    staleTime: Infinity,
  });
  const selected = new Set(value);
  if (themes.isPending) {
    return (
      <div className="flex gap-1.5">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-28" />
      </div>
    );
  }
  if (themes.isError) return <p className="text-xs text-muted-foreground">Themes unavailable</p>;
  if (themes.data.length === 0) return <p className="text-xs text-muted-foreground">No themes bundled.</p>;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Themes">
      {themes.data.map((theme) => (
        <Toggle
          key={theme.id}
          pressed={selected.has(theme.id)}
          title={theme.sample.join(', ')}
          onClick={() => onChange(selected.has(theme.id) ? value.filter((t) => t !== theme.id) : [...value, theme.id].slice(0, 20))}
        >
          {theme.name}
          <span className="font-mono text-xs opacity-70">{theme.size}</span>
        </Toggle>
      ))}
    </div>
  );
}

function CandidateRow({
  candidate,
  selected,
  onSelect,
  onRemove,
}: {
  candidate: Candidate;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  onRemove: () => void;
}) {
  const id = `cand-${candidate.key}`;
  return (
    <li className={cn('grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-start gap-x-2 rounded-md px-1.5 py-2 text-sm transition-colors', selected ? 'bg-selected' : 'hover:bg-hover')}>
      <span className="flex h-5 items-center justify-center">
        <Checkbox id={id} checked={selected} disabled={!candidate.valid} onCheckedChange={(v) => onSelect(v === true)} aria-label={`Select ${candidate.key}`} />
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-3">
          <label htmlFor={id} className="min-w-0 truncate font-mono leading-5" title={candidate.key}>
            {candidate.key}
          </label>
          <span className="shrink-0 text-xs text-muted-foreground">{STRATEGY_LABEL[candidate.strategy]}</span>
          {candidate.valid ? null : <StatusLabel status={{ label: 'Invalid', tone: 'negative' }} className="shrink-0 text-xs" />}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {candidate.rule}
          {candidate.issues.length > 0 ? <span className={cn(!candidate.valid && 'text-foreground')}> · {candidate.issues.join('; ')}</span> : null}
        </p>
      </div>
      <Button size="icon-xs" variant="quiet" aria-label={`Remove ${candidate.key}`} onClick={onRemove}>
        <X />
      </Button>
    </li>
  );
}

function DiscoverForm() {
  const router = useRouter();
  const client = useQueryClient();
  const searchParams = useSearchParams();
  const criteriaParam = searchParams.get('criteria');
  const [draft, setDraft] = useState<Draft>(() => {
    const stored = readJson<Partial<Draft>>('session', DRAFT_KEY);
    return stored?.form ? { ...EMPTY_DRAFT, ...stored, form: { ...EMPTY_FORM, ...stored.form } } : EMPTY_DRAFT;
  });
  /** Saved candidate list from restored criteria, applied once the restored rules generate. */
  const [restoreSelection, setRestoreSelection] = useState<string[] | null>(null);
  const [newName, setNewName] = useState('');
  const [filter, setFilter] = useState('');
  const [shown, setShown] = useState(PAGE);
  const { form } = draft;
  const setForm = (patch: Partial<Form>) => setDraft((d) => ({ ...d, form: { ...d.form, ...patch } }));

  useEffect(() => {
    const timer = setTimeout(() => writeJson('session', DRAFT_KEY, draft), 300);
    return () => clearTimeout(timer);
  }, [draft]);

  // Restoring saved criteria fills the form only. Generation is local and no scan starts.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!criteriaParam || handled.current === criteriaParam) return;
    handled.current = criteriaParam;
    window.history.replaceState(null, '', '/discover');
    api
      .call('getCriteria', { params: { id: criteriaParam } })
      .then(({ data }) => {
        const lines = (data.input ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (data.generation && hasSource(data.generation)) {
          setDraft({ form: formFromRequest(data.generation, data.extensions), added: [], removed: [], excluded: [] });
          // An empty saved input is an explicit empty selection; a missing one keeps the default.
          setRestoreSelection(data.input === null ? null : lines);
        } else {
          setDraft({ form: { ...EMPTY_FORM, extensions: data.extensions }, added: lines, removed: [], excluded: [] });
          setRestoreSelection(null);
        }
        toast.success(`Restored ${data.name}`);
      })
      .catch(() => toast.error('Could not restore those criteria.'));
  }, [criteriaParam]);

  const { request, errors } = useMemo(() => buildRequest(form), [form]);
  const requestKey = JSON.stringify(request);
  const debouncedKey = useDebounced(requestKey, 350);
  const debounced = useMemo(() => JSON.parse(debouncedKey) as GenerationRequest | null, [debouncedKey]);
  const enabled = Boolean(debounced && hasSource(debounced));

  const preview = useQuery({
    queryKey: ['generationPreview', debouncedKey],
    queryFn: ({ signal }) => api.call('previewGeneration', { body: debounced!, signal }).then((r) => r.data),
    enabled,
    placeholderData: (previous) => previous,
    staleTime: Infinity,
    retry: false,
  });
  const settled = enabled && debouncedKey === requestKey && !preview.isPlaceholderData;
  const data: GenerationPreview | undefined = enabled ? preview.data : undefined;

  // Restored criteria carry the selected list: names outside the regenerated set come back as
  // added, generated names missing from it come back deselected. Adjusted during render, once.
  if (restoreSelection && settled && preview.data) {
    const generatedKeys = new Set(preview.data.candidates.map((c) => c.domain ?? c.name));
    const wanted = new Set(restoreSelection);
    setRestoreSelection(null);
    setDraft((d) => ({
      ...d,
      added: restoreSelection.filter((key) => !generatedKeys.has(key)),
      removed: [],
      excluded: preview.data!.candidates.filter((c) => c.valid && !wanted.has(c.domain ?? c.name)).map((c) => c.domain ?? c.name),
    }));
  }

  const removed = useMemo(() => new Set(draft.removed), [draft.removed]);
  const excluded = useMemo(() => new Set(draft.excluded), [draft.excluded]);
  const candidates = useMemo(() => {
    const generated = (data?.candidates ?? []).map(fromGenerated).filter((c) => !removed.has(c.key));
    const keys = new Set(generated.map((c) => c.key));
    const added = draft.added.map(addedCandidate).filter((c) => !keys.has(c.key) && !removed.has(c.key));
    // Valid candidates first; invalid ones stay visible with their issues, after them.
    return [...added, ...generated].sort((a, b) => Number(b.valid) - Number(a.valid));
  }, [data, draft.added, removed]);
  const selected = candidates.filter((c) => c.valid && !excluded.has(c.key));
  const selectedChecks = expandedDomains(selected, form.extensions);
  const visible = filter.trim() ? candidates.filter((c) => c.key.includes(filter.trim().toLowerCase())) : candidates;
  const selectable = visible.filter((c) => c.valid);
  const allVisibleSelected = selectable.length > 0 && selectable.every((c) => !excluded.has(c.key));
  const someVisibleSelected = selectable.some((c) => !excluded.has(c.key));

  const setSelected = (keys: string[], on: boolean) =>
    setDraft((d) => {
      const next = new Set(d.excluded);
      for (const key of keys) {
        if (on) next.delete(key);
        else next.add(key);
      }
      return { ...d, excluded: [...next] };
    });
  const remove = (candidate: Candidate) =>
    setDraft((d) =>
      candidate.strategy === 'added'
        ? { ...d, added: d.added.filter((a) => addedCandidate(a).key !== candidate.key) }
        : { ...d, removed: [...d.removed, candidate.key] },
    );
  const addNames = () => {
    const values = parseList(newName);
    if (values.length === 0) return;
    setDraft((d) => {
      const known = new Set(d.added.map((a) => addedCandidate(a).key));
      const fresh: string[] = [];
      for (const value of values) {
        const key = addedCandidate(value).key;
        if (!known.has(key)) {
          known.add(key);
          fresh.push(value);
        }
      }
      const restored = new Set(values.map((v) => addedCandidate(v).key));
      return { ...d, added: [...d.added, ...fresh], removed: d.removed.filter((r) => !restored.has(r)), excluded: d.excluded.filter((e) => !restored.has(e)) };
    });
    setNewName('');
  };

  const saveCriteria = useMutation({
    mutationFn: async (name: string) =>
      (
        await api.call('createCriteria', {
          body: {
            name,
            generation: request && hasSource(request) ? request : undefined,
            extensions: form.extensions,
            input: selected.map((c) => c.key).join('\n'),
          },
        })
      ).data,
    onSuccess: (criteria) => {
      void client.invalidateQueries({ queryKey: qk.criteria });
      toast.success(`Saved ${criteria.name}`, { action: { label: 'Shortlists', onClick: () => router.push('/collections') } });
    },
  });

  const sendToScan = () => {
    const url = stashScanInput({ text: selected.map((c) => c.key).join('\n'), extensions: form.extensions, format: 'lines' });
    router.push(url);
  };

  const counts = data?.counts;
  const pending = enabled && (preview.isFetching || debouncedKey !== requestKey);
  // Save and Send act on the list shown, so they wait until it matches the current rules.
  const current =
    request !== null && debouncedKey === requestKey && (!hasSource(request) || (settled && preview.isSuccess && !preview.isFetching));

  return (
    <>
      <PageHeader
        title="Discover"
        actions={
          <>
            <SaveCriteriaPopover disabled={!current} pending={saveCriteria.isPending} onSave={(name) => saveCriteria.mutateAsync(name)} />
            <Button variant="primary" disabled={!current || selected.length === 0} onClick={sendToScan}>
              <ArrowRight />
              {selected.length > 0 ? `Send ${formatCount(selected.length)} to scan` : 'Send to scan'}
            </Button>
          </>
        }
      />
      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Field label="Roots" htmlFor="gen-roots" hint={fieldError(errors.roots)}>
            <Textarea
              id="gen-roots"
              value={form.roots}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-invalid={Boolean(errors.roots) || undefined}
              onChange={(e) => setForm({ roots: e.target.value })}
              className="min-h-28 font-mono text-[13px]"
            />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">Themes</span>
            <ThemePicker value={form.themes} onChange={(themes) => setForm({ themes })} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Prefixes" htmlFor="gen-prefixes" hint={fieldError(errors.prefixes)}>
              <Input id="gen-prefixes" value={form.prefixes} spellCheck={false} aria-invalid={Boolean(errors.prefixes) || undefined} onChange={(e) => setForm({ prefixes: e.target.value })} className="font-mono" />
            </Field>
            <Field label="Suffixes" htmlFor="gen-suffixes" hint={fieldError(errors.suffixes)}>
              <Input id="gen-suffixes" value={form.suffixes} spellCheck={false} aria-invalid={Boolean(errors.suffixes) || undefined} onChange={(e) => setForm({ suffixes: e.target.value })} className="font-mono" />
            </Field>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground" id="gen-strategies">
              Strategies
            </span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="gen-strategies">
              {STRATEGIES.map((strategy) => {
                const on = form.strategies.includes(strategy.value);
                return (
                  <Toggle
                    key={strategy.value}
                    pressed={on}
                    onClick={() => setForm({ strategies: on ? form.strategies.filter((s) => s !== strategy.value) : [...form.strategies, strategy.value] })}
                  >
                    {strategy.label}
                  </Toggle>
                );
              })}
            </div>
            {errors.strategies ? <p className="text-xs text-negative">{errors.strategies}</p> : null}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Minimum length" htmlFor="gen-min" hint={fieldError(errors.minLength)}>
              <Input id="gen-min" inputMode="numeric" value={form.minLength} aria-invalid={Boolean(errors.minLength) || undefined} onChange={(e) => setForm({ minLength: e.target.value })} className="font-mono" />
            </Field>
            <Field label="Maximum length" htmlFor="gen-max" hint={fieldError(errors.maxLength)}>
              <Input id="gen-max" inputMode="numeric" value={form.maxLength} aria-invalid={Boolean(errors.maxLength) || undefined} onChange={(e) => setForm({ maxLength: e.target.value })} className="font-mono" />
            </Field>
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <label className="flex items-center gap-3 text-sm">
              <Switch checked={form.allowDigits} onCheckedChange={(allowDigits) => setForm({ allowDigits })} aria-label="Allow digits" />
              Allow digits
            </label>
            <label className="flex items-center gap-3 text-sm">
              <Switch checked={form.allowHyphens} onCheckedChange={(allowHyphens) => setForm({ allowHyphens })} aria-label="Allow hyphens" />
              Allow hyphens
            </label>
          </div>
          <Field label="Exclude" htmlFor="gen-exclude" hint={fieldError(errors.exclude)}>
            <Input id="gen-exclude" value={form.exclude} spellCheck={false} aria-invalid={Boolean(errors.exclude) || undefined} onChange={(e) => setForm({ exclude: e.target.value })} className="font-mono" />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">Extensions</span>
            <ExtensionPicker value={form.extensions} onChange={(extensions) => setForm({ extensions })} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Limit" htmlFor="gen-limit" hint={fieldError(errors.limit)}>
              <Input id="gen-limit" inputMode="numeric" value={form.limit} aria-invalid={Boolean(errors.limit) || undefined} onChange={(e) => setForm({ limit: e.target.value })} className="font-mono" />
            </Field>
            <Field label="Seed" htmlFor="gen-seed" hint={fieldError(errors.seed)}>
              <Input id="gen-seed" inputMode="numeric" value={form.seed} placeholder="1" aria-invalid={Boolean(errors.seed) || undefined} onChange={(e) => setForm({ seed: e.target.value })} className="font-mono" />
            </Field>
          </div>
        </div>

        <section aria-label="Candidates" aria-busy={pending} className="min-w-0">
          <SectionTitle>Candidates</SectionTitle>
          {preview.isError && enabled ? <ErrorState error={preview.error} onRetry={() => preview.refetch()} className="mb-4" /> : null}
          <div className={cn('transition-opacity', pending && 'opacity-60')}>
            <dl data-testid="generation-counts" className="flex flex-wrap gap-x-8 gap-y-4">
              <Stat label="Generated" value={counts?.generated} testId="count-generated" />
              <Stat label="Unique" value={counts?.unique} testId="count-unique" />
              <Stat label="Duplicates" value={counts?.duplicates} testId="count-duplicates" />
              <Stat label="Invalid" value={counts?.invalid} testId="count-invalid" />
              <Stat label="Filtered out" value={counts?.filtered} testId="count-filtered" />
              <Stat label="Expanded checks" value={data?.expandedChecks} testId="count-expanded" />
            </dl>
            <p className="mt-4 text-sm" data-testid="selection-summary">
              <span className="font-medium">{formatCount(selected.length)} selected</span>
              <span className="text-muted-foreground">
                {' '}
                · {plural(selectedChecks, 'check')} across {plural(form.extensions.length, 'extension')}
              </span>
            </p>

            <form
              className="mt-6 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                addNames();
              }}
            >
              <Input
                aria-label="Add names"
                placeholder="Add names or domains"
                value={newName}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => setNewName(e.target.value)}
                className="font-mono"
              />
              <Button type="submit" variant="secondary" disabled={!newName.trim()}>
                <Plus />
                Add
              </Button>
            </form>

            {candidates.length === 0 ? (
              <EmptyState>No candidates yet.</EmptyState>
            ) : (
              <>
                <div className="mb-1 mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <label className="flex h-9 items-center gap-2 px-1.5 text-sm text-muted-foreground">
                    <Checkbox
                      aria-label="Select all shown candidates"
                      checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                      onCheckedChange={(v) => setSelected(selectable.map((c) => c.key), v === true)}
                    />
                    {plural(visible.length, 'candidate')}
                  </label>
                  <div className="relative ml-auto w-full sm:w-56">
                    <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input type="search" aria-label="Filter candidates" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} className="pl-9" />
                  </div>
                </div>
                <ul aria-label="Candidate list" className="flex flex-col gap-0.5">
                  {visible.slice(0, shown).map((candidate) => (
                    <CandidateRow
                      key={candidate.key}
                      candidate={candidate}
                      selected={candidate.valid && !excluded.has(candidate.key)}
                      onSelect={(on) => setSelected([candidate.key], on)}
                      onRemove={() => remove(candidate)}
                    />
                  ))}
                </ul>
                {visible.length > shown ? (
                  <div className="mt-4 flex justify-center">
                    <Button variant="ghost" onClick={() => setShown((n) => n + PAGE)}>
                      Show {formatCount(Math.min(PAGE, visible.length - shown))} more
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function DiscoverSkeleton() {
  return (
    <>
      <PageHeader title="Discover" />
      <div className="grid gap-12 lg:grid-cols-[26rem_1fr]">
        <Skeleton className="h-96" />
        <Skeleton className="h-64" />
      </div>
    </>
  );
}

/** The form restores a session draft from browser storage, so it renders on the client only. */
export function DiscoverPage() {
  const isClient = useIsClient();
  if (!isClient) return <DiscoverSkeleton />;
  return (
    <Suspense fallback={<DiscoverSkeleton />}>
      <DiscoverForm />
    </Suspense>
  );
}
