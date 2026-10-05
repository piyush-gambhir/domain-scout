'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Play } from 'lucide-react';
import { toast } from 'sonner';
import type { InputPreview, InputPreviewRow, InputRowStatus } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { formatCount, plural } from '@/lib/format';
import type { StatusInfo } from '@/lib/labels';
import { qk } from '@/lib/queries';
import { readJson, writeJson } from '@/lib/storage';
import { type ScanInputRestore, takeScanInput } from '@/lib/restore';
import { useDebounced } from '@/lib/use-debounced';
import { useIdempotency } from '@/lib/use-idempotency';
import { cn, hashString } from '@/lib/utils';
import { DomainName } from '../domain/domain-name';
import { ErrorState, PageHeader, SectionTitle } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { Input, Textarea } from '../ui/input';
import { Field } from '../ui/label';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { SwitchField } from '../ui/switch';
import { ExtensionPicker } from './extension-picker';

type Format = 'auto' | 'lines' | 'csv';

interface Draft {
  text: string;
  format: Format;
  csvColumn: string;
  extensions: string[];
  label: string;
  recheck: boolean;
}

const DRAFT_KEY = 'ds.scan.draft';
const MAX_TEXT = 5_000_000;
const LIST_LIMIT = 200;
const EMPTY: Draft = { text: '', format: 'auto', csvColumn: '', extensions: [], label: '', recheck: false };

const ROW_STATUS: Record<InputRowStatus, StatusInfo> = {
  valid: { label: 'Valid', tone: 'positive' },
  duplicate: { label: 'Duplicate', tone: 'muted' },
  invalid: { label: 'Invalid', tone: 'negative' },
  ambiguous: { label: 'Ambiguous', tone: 'caution', unresolved: true },
};

function fromRestore(input: ScanInputRestore): Draft {
  return {
    ...EMPTY,
    text: input.text,
    extensions: input.extensions,
    format: input.format ?? 'auto',
    csvColumn: input.csvColumn ?? '',
    label: input.label ?? '',
  };
}

/** Initial form state: a stashed restore wins, then the session draft. Client only. */
function initialDraft(restoreKey: string | null): Draft {
  if (restoreKey) {
    const restored = readJson<ScanInputRestore>('session', `ds.restore.${restoreKey}`);
    if (restored) return fromRestore(restored);
  }
  return { ...EMPTY, ...(readJson<Partial<Draft>>('session', DRAFT_KEY) ?? {}) };
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

function ProblemRow({ row, onUseSuggestion }: { row: InputPreviewRow; onUseSuggestion?: () => void }) {
  return (
    <li className="grid grid-cols-[3rem_1fr] gap-x-3 py-2 text-sm sm:grid-cols-[3rem_minmax(0,14rem)_8rem_1fr]">
      <span className="font-mono text-xs leading-5 text-muted-foreground tabular">{row.row}</span>
      <span className="min-w-0 truncate font-mono" title={row.original}>
        {row.original || <span className="text-muted-foreground">(empty)</span>}
      </span>
      <StatusLabel status={ROW_STATUS[row.status]} className="col-start-2 sm:col-start-auto" />
      <span className="col-start-2 text-muted-foreground sm:col-start-auto">
        {row.status === 'duplicate' && row.duplicateOf ? `Same as ${row.duplicateOf}. ` : null}
        {row.reasons.map((r) => r.message).join(' ')}
        {row.suggestion ? (
          <span className="ml-1 inline-flex items-center gap-2 text-foreground">
            <span className="font-mono">{row.suggestion}</span>
            {onUseSuggestion ? (
              <Button size="sm" variant="secondary" className="h-6 px-2 text-xs" onClick={onUseSuggestion}>
                Use
              </Button>
            ) : null}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function PreviewPanel({
  preview,
  pending,
  error,
  onRetry,
  onUseSuggestion,
}: {
  preview: InputPreview | undefined;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  onUseSuggestion: (row: InputPreviewRow) => (() => void) | undefined;
}) {
  const counts = preview?.counts;
  const problems = preview?.rows.filter((r) => r.status !== 'valid') ?? [];
  const valid = preview?.rows.filter((r) => r.status === 'valid') ?? [];

  return (
    <section aria-label="Preview" aria-busy={pending} className={cn('transition-opacity', pending && 'opacity-60')}>
      <SectionTitle>Preview</SectionTitle>
      {error ? <ErrorState error={error} onRetry={onRetry} className="mb-4" /> : null}
      <dl data-testid="preview-counts" className="grid grid-cols-3 gap-x-6 gap-y-4 sm:grid-cols-4 xl:grid-cols-7">
        <Stat label="Rows" value={counts?.inputRows} testId="count-rows" />
        <Stat label="Valid" value={counts?.valid} testId="count-valid" />
        <Stat label="Duplicates" value={counts?.duplicate} testId="count-duplicates" />
        <Stat label="Invalid" value={counts?.invalid} testId="count-invalid" />
        <Stat label="Ambiguous" value={counts?.ambiguous} testId="count-ambiguous" />
        <Stat label="Unique domains" value={counts?.uniqueDomains} testId="count-unique" />
        <Stat label="Total checks" value={counts?.totalChecks} testId="count-checks" emphasis />
      </dl>

      {problems.length > 0 ? (
        <div className="mt-8">
          <h3 className="mb-1 text-sm font-medium">
            Needs attention <span className="font-mono text-muted-foreground">{formatCount(problems.length)}</span>
          </h3>
          <ul data-testid="preview-problems">
            {problems.slice(0, LIST_LIMIT).map((row) => (
              <ProblemRow key={`${row.row}-${row.original}`} row={row} onUseSuggestion={onUseSuggestion(row)} />
            ))}
          </ul>
          {problems.length > LIST_LIMIT ? <p className="mt-2 text-xs text-muted-foreground">{plural(problems.length - LIST_LIMIT, 'more row')}</p> : null}
        </div>
      ) : null}

      {valid.length > 0 ? (
        <div className="mt-8">
          <h3 className="mb-1 text-sm font-medium">
            Domains <span className="font-mono text-muted-foreground">{formatCount(preview?.domains.length ?? valid.length)}</span>
          </h3>
          <ul className="text-sm">
            {valid.slice(0, LIST_LIMIT).map((row) =>
              row.domain ? (
                <li key={`${row.row}-${row.domain.ascii}`} className="flex min-w-0 items-baseline gap-3 py-1">
                  <DomainName ascii={row.domain.ascii} unicode={row.domain.unicode} />
                  {row.expandedFrom ? (
                    <span className="shrink-0 text-xs text-muted-foreground">from {row.expandedFrom}</span>
                  ) : row.original.trim().toLowerCase() !== row.domain.ascii && row.original.trim() !== row.domain.unicode ? (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">from {row.original.trim()}</span>
                  ) : null}
                </li>
              ) : null,
            )}
          </ul>
          {valid.length > LIST_LIMIT ? <p className="mt-2 text-xs text-muted-foreground">{plural(valid.length - LIST_LIMIT, 'more row')}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

export function ScanForm() {
  const router = useRouter();
  const client = useQueryClient();
  const searchParams = useSearchParams();
  const restoreKey = searchParams.get('restore');
  const jobParam = searchParams.get('job');
  const criteriaParam = searchParams.get('criteria');
  const [draft, setDraft] = useState<Draft>(() => initialDraft(restoreKey));
  const fileInput = useRef<HTMLInputElement>(null);
  const idempotency = useIdempotency();
  const editVersion = useRef(0);
  const update = (patch: Partial<Draft>) => {
    editVersion.current += 1;
    setDraft((current) => ({ ...current, ...patch }));
  };

  // Consume each restore source once, then drop it from the URL. Restoring never runs anything.
  // Clearing the URL re-runs this effect, so it must not cancel the fetch it started; a late
  // response is ignored when the user has edited the form or another restore started meanwhile.
  const handledSource = useRef<string | null>(null);
  useEffect(() => {
    const source = restoreKey ? `restore:${restoreKey}` : jobParam ? `job:${jobParam}` : criteriaParam ? `criteria:${criteriaParam}` : null;
    if (!source || handledSource.current === source) return;
    handledSource.current = source;
    window.history.replaceState(null, '', '/scan');
    const startedAt = editVersion.current;
    const apply = (input: ScanInputRestore) => {
      if (handledSource.current === source && editVersion.current === startedAt) setDraft(fromRestore(input));
    };
    if (restoreKey) {
      // The initial render already used a stash present at mount; this covers stashes that arrive later.
      const restored = takeScanInput(restoreKey);
      if (restored) void Promise.resolve(restored).then(apply);
    } else if (jobParam) {
      api
        .call('getJob', { params: { id: jobParam } })
        .then(({ data }) => apply({ text: data.input.text ?? '', extensions: data.input.extensions, label: data.label ?? '' }))
        .catch(() => toast.error('Could not restore that scan.'));
    } else if (criteriaParam) {
      api
        .call('getCriteria', { params: { id: criteriaParam } })
        .then(({ data }) => apply({ text: data.input ?? '', extensions: data.extensions, label: data.name }))
        .catch(() => toast.error('Could not restore those criteria.'));
    }
  }, [restoreKey, jobParam, criteriaParam]);

  // Keep the form across navigation within the session.
  useEffect(() => {
    const timer = setTimeout(() => writeJson('session', DRAFT_KEY, draft.text.length <= 1_000_000 ? draft : { ...draft, text: '' }), 300);
    return () => clearTimeout(timer);
  }, [draft]);

  const request = useMemo(
    () => ({ text: draft.text, format: draft.format, csvColumn: draft.csvColumn.trim(), extensions: draft.extensions }),
    [draft.text, draft.format, draft.csvColumn, draft.extensions],
  );
  const debounced = useDebounced(request, 350);
  const hasInput = debounced.text.trim().length > 0;

  const preview = useQuery({
    queryKey: ['inputPreview', hashString(debounced.text), debounced.format, debounced.csvColumn, debounced.extensions],
    queryFn: ({ signal }) =>
      api
        .call('previewInput', {
          body: {
            text: debounced.text,
            format: debounced.format,
            csvColumn: debounced.format === 'csv' && debounced.csvColumn ? debounced.csvColumn : undefined,
            extensions: debounced.extensions,
          },
          signal,
        })
        .then((r) => r.data),
    enabled: hasInput,
    placeholderData: (previous) => previous,
    staleTime: Infinity,
    retry: false,
  });

  const current = hasInput && debounced === request && !preview.isPlaceholderData ? preview.data : undefined;
  const totalChecks = current?.counts.totalChecks ?? 0;
  const tooLarge = draft.text.length > MAX_TEXT;

  const run = useMutation({
    mutationFn: async () => {
      const body = {
        type: 'registry_scan' as const,
        label: draft.label.trim() || undefined,
        input: {
          text: draft.text,
          format: draft.format,
          csvColumn: draft.format === 'csv' && draft.csvColumn.trim() ? draft.csvColumn.trim() : undefined,
          extensions: draft.extensions,
        },
        recheck: draft.recheck,
      };
      return (await api.call('createJob', { body, idempotencyKey: idempotency.keyFor(body) })).data;
    },
    onSuccess: (job) => {
      idempotency.reset();
      client.setQueryData(qk.job(job.id), job);
      void client.invalidateQueries({ queryKey: qk.jobs() });
      router.push(`/jobs/${job.id}`);
    },
  });

  const canRun = totalChecks > 0 && !tooLarge && !run.isPending;
  const runRef = useRef<() => void>(() => {});
  useEffect(() => {
    runRef.current = () => {
      if (canRun) run.mutate();
    };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        runRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const loadFile = async (file: File) => {
    if (file.size > MAX_TEXT) {
      toast.error('That file is larger than 5 MB.');
      return;
    }
    const text = await file.text();
    update({ text, format: /\.csv$/i.test(file.name) ? 'csv' : 'auto' });
    toast.success(`Imported ${file.name}`);
  };

  const suggestionHandler = (row: InputPreviewRow) => {
    if (!row.suggestion || row.status !== 'ambiguous' || draft.format === 'csv') return undefined;
    return () => {
      const lines = draft.text.split(/\r?\n/);
      const index = row.row - 1;
      if (lines[index]?.trim() !== row.original.trim()) {
        toast.error('The input changed. Edit the row directly.');
        return;
      }
      lines[index] = row.suggestion!;
      update({ text: lines.join('\n') });
    };
  };

  return (
    <>
      <PageHeader
        title="Scan"
        actions={
          <Button variant="primary" disabled={!canRun} onClick={() => run.mutate()}>
            <Play />
            {totalChecks > 0 ? `Run ${plural(totalChecks, 'check')}` : 'Run'}
          </Button>
        }
      />
      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="scan-input" className="text-xs font-medium text-muted-foreground">
                Domains or names
              </label>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="quiet" onClick={() => fileInput.current?.click()}>
                  <FileUp />
                  Import TXT or CSV
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".txt,.csv,text/plain,text/csv"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void loadFile(file);
                    event.target.value = '';
                  }}
                />
              </div>
            </div>
            <Textarea
              id="scan-input"
              value={draft.text}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              aria-invalid={tooLarge || undefined}
              onChange={(event) => update({ text: event.target.value })}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                const file = event.dataTransfer.files?.[0];
                if (file) {
                  event.preventDefault();
                  void loadFile(file);
                }
              }}
              className="min-h-64 font-mono text-[13px] lg:min-h-80"
            />
            {tooLarge ? <p className="text-xs text-negative">Input is larger than 5 MB.</p> : null}
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">Extensions</span>
            <ExtensionPicker value={draft.extensions} onChange={(extensions) => update({ extensions })} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Format" htmlFor="scan-format">
              <Select
                id="scan-format"
                value={draft.format}
                onValueChange={(value) => update({ format: value as Format })}
                options={[
                  { value: 'auto', label: 'Detect' },
                  { value: 'lines', label: 'One per line' },
                  { value: 'csv', label: 'CSV' },
                ]}
              />
            </Field>
            {draft.format === 'csv' ? (
              <Field label="CSV column" htmlFor="scan-csv-column">
                <Input id="scan-csv-column" value={draft.csvColumn} placeholder="First column" onChange={(e) => update({ csvColumn: e.target.value })} />
              </Field>
            ) : null}
            <Field label="Label" htmlFor="scan-label">
              <Input id="scan-label" value={draft.label} maxLength={200} onChange={(e) => update({ label: e.target.value })} />
            </Field>
          </div>
          <SwitchField id="scan-recheck" label="Ignore cached results" checked={draft.recheck} onCheckedChange={(recheck) => update({ recheck })} className="max-w-sm" />
        </div>

        <div className="min-w-0">
          {hasInput ? (
            <PreviewPanel
              preview={preview.data}
              pending={preview.isFetching || debounced !== request}
              error={preview.isError ? preview.error : null}
              onRetry={() => preview.refetch()}
              onUseSuggestion={suggestionHandler}
            />
          ) : (
            <section aria-label="Preview">
              <SectionTitle>Preview</SectionTitle>
              <p className="text-sm text-muted-foreground">Nothing to preview.</p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

export function ScanFormSkeleton() {
  return (
    <>
      <PageHeader title="Scan" />
      <div className="grid gap-12 lg:grid-cols-2">
        <Skeleton className="h-80" />
        <Skeleton className="h-40" />
      </div>
    </>
  );
}
