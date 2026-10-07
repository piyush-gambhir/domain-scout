'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, LoaderCircle, Paperclip, Search, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Tooltip } from '../ui/tooltip';
import { type SearchMode, readSearchFile } from './search-state';

/** Grows with its content up to a few lines, then scrolls. */
function useAutoHeight(ref: React.RefObject<HTMLTextAreaElement | null>, value: string, lineHeight: number, maxLines: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    const padding = parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom);
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * maxLines + padding)}px`;
    if (maxLines === 1) el.scrollTop = 0;
  }, [ref, value, lineHeight, maxLines]);
}

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  mode: SearchMode;
  onModeChange: (mode: SearchMode) => void;
  /** Enter in names mode. */
  onSubmit: () => void;
  canSubmit: boolean;
  pending: boolean;
  size: 'hero' | 'compact';
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** A dropped or chosen file replaced the text. */
  onFile: (file: { text: string; format: 'auto' | 'lines' | 'csv'; fileName: string }) => void;
  fileName: string | null;
  onClearFile: () => void;
  /** Options control rendered inside the field (a popover trigger). */
  options: React.ReactNode;
  autoFocus?: boolean;
  /** Lines shown before the field scrolls; a long list can stay one line until focused. */
  maxLines?: number;
}

/**
 * The one input a search starts from: names, domains or a pasted list. Enter searches, Shift+Enter
 * adds a line, and a TXT or CSV file can be dropped, pasted or chosen. "Ideas" turns it into keywords
 * for local name suggestions.
 */
export function SearchField({
  value,
  onChange,
  mode,
  onModeChange,
  onSubmit,
  canSubmit,
  pending,
  size,
  inputRef,
  onFile,
  fileName,
  onClearFile,
  options,
  autoFocus,
  maxLines = 6,
}: SearchFieldProps) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const hero = size === 'hero';
  useAutoHeight(ref, value, hero ? 24 : 20, maxLines);
  const lines = value ? value.split('\n').filter((l) => l.trim()).length : 0;

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus, ref]);

  const load = async (file: File) => {
    const result = await readSearchFile(file);
    if ('error' in result) toast.error(result.error);
    else onFile(result);
  };

  const ideas = mode === 'ideas';
  const placeholder = ideas ? 'Keywords for name ideas' : 'Names, domains or a pasted list';

  return (
    <div
      data-dragging={dragging || undefined}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) setDragging(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        const file = event.dataTransfer.files?.[0];
        setDragging(false);
        if (file) {
          event.preventDefault();
          void load(file);
        }
      }}
      className={cn(
        'group/field relative flex w-full items-start gap-1 rounded-xl bg-input transition-[background-color,box-shadow] duration-150',
        'focus-within:bg-popover focus-within:shadow-[0_0_0_1px_var(--control),0_8px_24px_-12px_rgb(0_0_0/0.25)] dark:focus-within:shadow-[0_0_0_1px_var(--control),0_8px_24px_-12px_rgb(0_0_0/0.8)]',
        hero ? 'min-h-13 px-2 py-1.5' : 'min-h-10 px-1.5 py-1',
        dragging && 'bg-selected',
      )}
    >
      <span className={cn('grid shrink-0 place-items-center text-muted-foreground', hero ? 'size-10' : 'size-8')}>
        {pending ? <LoaderCircle className="size-[18px] motion-safe:animate-spin" aria-hidden /> : ideas ? <Sparkles className="size-[18px]" aria-hidden /> : <Search className="size-[18px]" aria-hidden />}
      </span>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        aria-label={ideas ? 'Keywords' : 'Search names or domains'}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        enterKeyHint={ideas ? 'done' : 'search'}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (!ideas && canSubmit && !pending) onSubmit();
        }}
        onPaste={(event) => {
          const file = event.clipboardData.files?.[0];
          if (file) {
            event.preventDefault();
            void load(file);
          }
        }}
        className={cn(
          'min-w-0 flex-1 resize-none bg-transparent text-foreground outline-none placeholder:text-muted-foreground',
          hero ? 'py-2.5 text-[15px] leading-6' : 'py-1.5 text-sm leading-5',
          // Collapsed: one unwrapped line, the rest of a long list waits until the field has focus.
          // The clip hides the next line peeking through the bottom padding.
          maxLines === 1 && 'overflow-hidden whitespace-pre [clip-path:inset(0_0_0.375rem_0)]',
        )}
      />
      {maxLines === 1 && lines > 1 ? (
        <span className={cn('flex shrink-0 items-center text-xs text-muted-foreground tabular', hero ? 'h-10' : 'h-8')}>{lines.toLocaleString('en')} lines</span>
      ) : null}
      <div className={cn('flex shrink-0 items-center gap-0.5', hero ? 'h-10' : 'h-8')}>
        {fileName ? (
          <span className="mr-1 inline-flex h-7 max-w-44 items-center gap-1 rounded-md bg-background/70 pl-2 pr-0.5 text-xs text-muted-foreground">
            <FileText className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{fileName}</span>
            <button type="button" aria-label={`Clear ${fileName}`} onClick={onClearFile} className="grid size-6 place-items-center rounded hover:bg-hover hover:text-foreground">
              <X className="size-3" />
            </button>
          </span>
        ) : null}
        <Tooltip content="Open a TXT or CSV file">
          <button
            type="button"
            aria-label="Open a TXT or CSV file"
            onClick={() => fileInput.current?.click()}
            className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <Paperclip className="size-4" />
          </button>
        </Tooltip>
        <input
          ref={fileInput}
          type="file"
          accept=".txt,.csv,.tsv,text/plain,text/csv"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void load(file);
            event.target.value = '';
          }}
        />
        {options}
        <button
          type="button"
          aria-pressed={ideas}
          onClick={() => onModeChange(ideas ? 'names' : 'ideas')}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors',
            ideas ? 'bg-primary text-primary-foreground hover:bg-primary/85' : 'text-muted-foreground hover:bg-hover hover:text-foreground',
          )}
        >
          <Sparkles className="size-3.5" aria-hidden />
          <span className={cn(hero ? 'max-sm:sr-only' : 'max-md:sr-only')}>Ideas</span>
        </button>
        {ideas ? null : (
          <button
            type="button"
            aria-label="Search"
            disabled={!canSubmit || pending}
            onClick={onSubmit}
            className={cn(
              'ml-0.5 grid place-items-center rounded-lg bg-primary text-primary-foreground transition-[opacity,background-color] hover:bg-primary/85 disabled:opacity-30',
              hero ? 'size-9' : 'size-8',
            )}
          >
            <ArrowRight className="size-4" />
          </button>
        )}
      </div>
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-selected/90 text-sm font-medium">Drop a TXT or CSV file</div>
      ) : null}
    </div>
  );
}

/** Icon button that opens the Options popover; a dot marks changed options. */
export function OptionsTrigger({ changed, ...props }: { changed: number } & React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      aria-label={changed ? `Options, ${changed} changed` : 'Options'}
      className="relative grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground data-[state=open]:bg-hover data-[state=open]:text-foreground"
      {...props}
    >
      <SlidersHorizontal className="size-4" />
      {changed ? <span aria-hidden className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-foreground" /> : null}
    </button>
  );
}
