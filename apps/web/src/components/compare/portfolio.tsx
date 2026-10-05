'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FileUp, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import type { OperationResponse, PortfolioEntry } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { PRICE_KIND } from '@/lib/labels';
import { formatDate, formatMoney, plural } from '@/lib/format';
import { qk, useProviders } from '@/lib/queries';
import { CheckedAt } from '../domain/time';
import { EmptyState, ErrorState, SectionTitle } from '../states';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Textarea } from '../ui/input';
import { SkeletonRows } from '../ui/skeleton';
import { SwitchField } from '../ui/switch';

type ImportResult = OperationResponse<'importPortfolio'>['data'];
type ComparisonRow = OperationResponse<'comparePortfolio'>['data'][number];

const MAX_TEXT = 2_000_000;
const thClass = 'pb-2 pr-4 text-xs font-medium text-muted-foreground';
const tdClass = 'py-2 pr-4 align-top';

function UserMoney({ money }: { money: PortfolioEntry['renewalPrice'] }) {
  return money ? <span className="font-mono tabular">{formatMoney(money.amount, money.currency)}</span> : <span className="text-muted-foreground">Not entered</span>;
}

function ImportForm() {
  const client = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [replace, setReplace] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const run = useMutation({
    mutationFn: async () => (await api.call('importPortfolio', { body: { text, replace } })).data,
    onSuccess: (data) => {
      setResult(data);
      setConfirmReplace(false);
      toast.success(`Imported ${plural(data.imported, 'domain')}`);
      void client.invalidateQueries({ queryKey: qk.portfolio });
    },
  });
  const submit = () => (replace ? setConfirmReplace(true) : run.mutate());

  return (
    <section aria-label="Import">
      <SectionTitle>Import</SectionTitle>
      <form
        className="flex max-w-3xl flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) submit();
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="portfolio-csv" className="text-xs font-medium text-muted-foreground">
            CSV
          </label>
          <Button size="sm" variant="quiet" onClick={() => fileInput.current?.click()}>
            <FileUp />
            Choose file
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              if (file.size > MAX_TEXT) {
                toast.error('That file is larger than 2 MB.');
                return;
              }
              setText(await file.text());
            }}
          />
        </div>
        <Textarea
          id="portfolio-csv"
          value={text}
          spellCheck={false}
          placeholder="domain,registrar,renewalDate,renewalPrice,currency,notes"
          onChange={(e) => setText(e.target.value)}
          className="min-h-32 font-mono text-[13px]"
        />
        <SwitchField id="portfolio-replace" label="Replace existing entries" checked={replace} onCheckedChange={setReplace} className="max-w-sm" />
        <div>
          <Button type="submit" variant="primary" disabled={!text.trim() || text.length > MAX_TEXT || run.isPending}>
            <Upload />
            Import
          </Button>
        </div>
      </form>
      {result ? (
        <div className="mt-6 max-w-3xl text-sm" data-testid="import-result">
          <p>
            {plural(result.imported, 'domain')} imported, {plural(result.updated, 'entry', 'entries')} updated
            {result.rejected.length ? `, ${plural(result.rejected.length, 'row')} rejected` : ''}
          </p>
          {result.rejected.length > 0 ? (
            <div className="relative -mx-1 mt-3 overflow-x-auto px-1">
              <table className="w-full min-w-[30rem] text-left text-sm">
                <thead>
                  <tr>
                    {['Row', 'Input', 'Reason'].map((h) => (
                      <th key={h} scope="col" className={thClass}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rejected.map((row) => (
                    <tr key={`${row.row}-${row.input}`}>
                      <td className={`${tdClass} font-mono text-xs text-muted-foreground tabular`}>{row.row}</td>
                      <td className={`${tdClass} max-w-64 truncate font-mono`}>{row.input}</td>
                      <td className={tdClass}>{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmReplace}
        onOpenChange={setConfirmReplace}
        title="Replace portfolio entries?"
        description="Every existing portfolio entry is removed before this import. Retained price evidence is kept."
        confirmLabel="Replace and import"
        pending={run.isPending}
        onConfirm={() => run.mutate()}
      />
    </section>
  );
}

function Entries() {
  const client = useQueryClient();
  const [deleting, setDeleting] = useState<PortfolioEntry | null>(null);
  const entries = useInfiniteQuery({
    queryKey: [...qk.portfolio, 'entries'],
    queryFn: ({ pageParam, signal }) => api.call('listPortfolio', { query: { cursor: pageParam, limit: 200 }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = entries.data?.pages.flatMap((p) => p.data) ?? [];
  const remove = useMutation({
    mutationFn: async (entry: PortfolioEntry) => api.call('deletePortfolioEntry', { params: { id: entry.id } }),
    onSuccess: () => {
      setDeleting(null);
      void client.invalidateQueries({ queryKey: qk.portfolio });
    },
  });
  return (
    <section aria-label="Your entries">
      <SectionTitle>Your entries</SectionTitle>
      {entries.isPending ? (
        <SkeletonRows rows={3} />
      ) : entries.isError ? (
        <ErrorState error={entries.error} onRetry={() => entries.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState className="py-6 text-left">No portfolio entries.</EmptyState>
      ) : (
        <div className="relative -mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead>
              <tr>
                {['Domain', 'Registrar', 'Renewal date', 'Renewal price', 'Notes', ''].map((h, i) => (
                  <th key={i} scope="col" className={thClass}>
                    {h || <span className="sr-only">Delete</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.id} data-testid="portfolio-entry">
                  <td className={`${tdClass} font-mono`}>{entry.domain}</td>
                  <td className={tdClass}>{entry.registrar ?? <span className="text-muted-foreground">Not entered</span>}</td>
                  <td className={tdClass}>{entry.renewalDate ? formatDate(`${entry.renewalDate}T00:00:00Z`) : <span className="text-muted-foreground">Not entered</span>}</td>
                  <td className={tdClass}>
                    <UserMoney money={entry.renewalPrice} />
                  </td>
                  <td className={`${tdClass} max-w-56 truncate text-muted-foreground`}>{entry.notes}</td>
                  <td className="py-1 text-right">
                    <Button size="icon-xs" variant="quiet" aria-label={`Delete ${entry.domain}`} onClick={() => setDeleting(entry)}>
                      <X />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {entries.hasNextPage ? (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" disabled={entries.isFetchingNextPage} onClick={() => entries.fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.domain ?? 'entry'}?`}
        description="Only this portfolio entry is removed."
        confirmLabel="Delete entry"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </section>
  );
}

function ComparisonBlock({ row, names }: { row: ComparisonRow; names: Map<string, string> }) {
  const { entry } = row;
  return (
    <article aria-label={entry.domain} data-testid="portfolio-comparison" className="grid gap-x-10 gap-y-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="text-sm">
        <h4 className="mb-2 font-mono font-semibold">
          <Link href={`/domains/${encodeURIComponent(entry.domain)}`} className="underline-offset-4 hover:underline">
            {entry.domain}
          </Link>
        </h4>
        <p className="mb-1 text-xs font-medium text-muted-foreground">You entered</p>
        <dl className="grid grid-cols-[6rem_1fr] gap-y-1">
          <dt className="text-muted-foreground">Registrar</dt>
          <dd>{entry.registrar ?? <span className="text-muted-foreground">Not entered</span>}</dd>
          <dt className="text-muted-foreground">Renews</dt>
          <dd>{entry.renewalDate ? formatDate(`${entry.renewalDate}T00:00:00Z`) : <span className="text-muted-foreground">Not entered</span>}</dd>
          <dt className="text-muted-foreground">Renewal</dt>
          <dd>
            <UserMoney money={entry.renewalPrice} />
          </dd>
        </dl>
      </div>
      <div className="min-w-0">
        <p className="mb-1 text-xs font-medium text-muted-foreground">Observed prices</p>
        {row.alternatives.length === 0 ? (
          <p className="text-sm text-muted-foreground">No retained renewal or transfer prices.</p>
        ) : (
          <div className="relative -mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead>
                <tr>
                  {['Provider', 'Renewal', 'Transfer', 'Observed'].map((h) => (
                    <th key={h} scope="col" className={thClass}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {row.alternatives.map((alt) => (
                  <tr key={`${alt.providerId}-${alt.observedAt}`}>
                    <td className={tdClass}>
                      {names.get(alt.providerId) ?? alt.providerId}
                      <span className="block text-xs text-muted-foreground">{PRICE_KIND[alt.kind]}</span>
                    </td>
                    <td className={tdClass}>
                      {alt.renewal ? <span className="font-mono tabular">{formatMoney(alt.renewal.amount, alt.renewal.currency)}</span> : <span className="text-muted-foreground">Unknown</span>}
                    </td>
                    <td className={tdClass}>
                      {alt.transfer ? <span className="font-mono tabular">{formatMoney(alt.transfer.amount, alt.transfer.currency)}</span> : <span className="text-muted-foreground">Unknown</span>}
                      <span className="block text-xs text-muted-foreground">
                        {alt.transferIncludesYears === null ? 'Included term unknown' : alt.transferIncludesYears === 0 ? 'No year included' : `Includes ${plural(alt.transferIncludesYears, 'year')}`}
                      </span>
                    </td>
                    <td className={tdClass}>
                      <CheckedAt iso={alt.observedAt} freshness={alt.freshness} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {row.notes.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground" aria-label="Estimates and notes">
            {row.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

function Comparison() {
  const providers = useProviders();
  const names = new Map((providers.data ?? []).map((p) => [p.id, p.name]));
  const comparison = useInfiniteQuery({
    queryKey: [...qk.portfolio, 'comparison'],
    queryFn: ({ pageParam, signal }) => api.call('comparePortfolio', { query: { cursor: pageParam, limit: 100 }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = comparison.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <section aria-label="Cost comparison">
      <SectionTitle>Cost comparison</SectionTitle>
      {comparison.isPending ? (
        <SkeletonRows rows={3} />
      ) : comparison.isError ? (
        <ErrorState error={comparison.error} onRetry={() => comparison.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState className="py-6 text-left">Nothing to compare.</EmptyState>
      ) : (
        <div className="flex flex-col gap-10">
          {rows.map((row) => (
            <ComparisonBlock key={row.entry.id} row={row} names={names} />
          ))}
        </div>
      )}
      {comparison.hasNextPage ? (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" disabled={comparison.isFetchingNextPage} onClick={() => comparison.fetchNextPage()}>
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** Domains you own, with your renewal facts kept apart from observed provider prices. Read-only. */
export function Portfolio() {
  return (
    <div className="flex flex-col gap-12">
      <ImportForm />
      <Entries />
      <Comparison />
    </div>
  );
}
