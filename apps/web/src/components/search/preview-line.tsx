'use client';

import type { InputPreview, InputPreviewRow } from '@domain-scout/contracts';
import { formatCount, plural } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Kbd } from '../ui/kbd';

/** What Enter would check, computed locally: "12 checks", plus rows that need attention. */
export function PreviewLine({ preview, stale, has, className }: { preview: InputPreview | undefined; stale: boolean; has: boolean; className?: string }) {
  if (!has) return null;
  const counts = preview?.counts;
  const problems = counts ? counts.invalid + counts.ambiguous : 0;
  return (
    <p className={cn('flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-muted-foreground transition-opacity', stale && 'opacity-60', className)} aria-live="polite" data-testid="search-preview">
      {counts ? (
        <>
          <span>
            <span className="font-medium text-foreground tabular">{formatCount(counts.totalChecks)}</span> {counts.totalChecks === 1 ? 'check' : 'checks'}
          </span>
          {problems ? <span>{plural(problems, 'row')} to review</span> : null}
        </>
      ) : null}
      {counts && counts.totalChecks > 0 ? <Kbd>↵</Kbd> : null}
    </p>
  );
}

/** Rows the search would skip or that need a choice, with the suggested fix where one exists. */
export function ProblemRows({ rows, onUseSuggestion }: { rows: InputPreviewRow[]; onUseSuggestion: (row: InputPreviewRow) => (() => void) | undefined }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Rows to review" className="flex min-h-0 flex-col">
      <h2 className="mb-1 px-1 text-xs font-medium text-muted-foreground">
        To review <span className="tabular">{formatCount(rows.length)}</span>
      </h2>
      <ul className="flex flex-col" data-testid="preview-problems">
        {rows.slice(0, 100).map((row) => {
          const use = onUseSuggestion(row);
          return (
            <li key={`${row.row}-${row.original}`} className="flex min-h-8 items-center gap-3 rounded-md px-1 text-sm">
              <span className="min-w-0 max-w-[40%] truncate font-mono" title={row.original}>
                {row.original || <span className="text-muted-foreground">(empty)</span>}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {row.status === 'duplicate' && row.duplicateOf ? `Same as ${row.duplicateOf}. ` : null}
                {row.reasons.map((r) => r.message).join(' ')}
              </span>
              {row.suggestion && use ? (
                <Button size="sm" variant="secondary" className="h-7 px-2 text-xs" onClick={use} aria-label={`Use ${row.suggestion}`}>
                  Use <span className="font-mono">{row.suggestion}</span>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
