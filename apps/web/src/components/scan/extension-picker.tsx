'use client';

import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import type { ExtensionPreset } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { qk, usePresets } from '@/lib/queries';
import { cn, uniq } from '@/lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Skeleton } from '../ui/skeleton';

const SUFFIX = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
export const MAX_EXTENSIONS = 2000;

/** Parses free entry such as "io, .co.uk  dev". Unicode suffixes become their ASCII (punycode) form. */
export function parseExtensions(input: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    const token = raw.trim().replace(/^\.+/, '').replace(/\.+$/, '').toLowerCase();
    if (!token) continue;
    let ascii = token;
    if (!SUFFIX.test(ascii)) {
      try {
        ascii = new URL(`http://x.${token}`).hostname.slice(2);
      } catch {
        ascii = '';
      }
    }
    if (ascii && SUFFIX.test(ascii) && ascii.length <= 253) valid.push(ascii);
    else invalid.push(raw.trim());
  }
  return { valid: uniq(valid), invalid };
}

const chipClass = 'inline-flex h-7 items-center gap-1 rounded-md px-2 font-mono text-[13px] transition-colors';

function PresetChip({
  preset,
  applied,
  onToggle,
  onDelete,
}: {
  preset: ExtensionPreset;
  applied: boolean;
  onToggle: () => void;
  onDelete?: () => void;
}) {
  return (
    <span className={cn('inline-flex items-center rounded-md', applied ? 'bg-primary text-primary-foreground' : 'bg-input')}>
      <button
        type="button"
        aria-pressed={applied}
        title={preset.extensions.map((e) => `.${e}`).join(' ')}
        onClick={onToggle}
        className={cn('h-7 rounded-md px-2.5 text-[13px] font-medium', !applied && 'hover:bg-selected')}
      >
        {preset.name}
        <span className={cn('ml-1.5 font-mono text-xs', applied ? 'opacity-70' : 'text-muted-foreground')}>{preset.extensions.length}</span>
      </button>
      {onDelete ? (
        <button
          type="button"
          aria-label={`Delete preset ${preset.name}`}
          onClick={onDelete}
          className={cn('mr-0.5 grid size-6 place-items-center rounded', applied ? 'hover:bg-primary-foreground/15' : 'text-muted-foreground hover:bg-selected hover:text-foreground')}
        >
          <X className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

export function ExtensionPicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const inputId = useId();
  const client = useQueryClient();
  const presets = usePresets();
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState<string[]>([]);
  const [presetName, setPresetName] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);

  const commit = (text: string) => {
    const parsed = parseExtensions(text);
    setInvalid(parsed.invalid);
    if (parsed.valid.length) onChange(uniq([...value, ...parsed.valid]).slice(0, MAX_EXTENSIONS));
    setDraft('');
  };

  const createPreset = useMutation({
    mutationFn: async () => (await api.call('createPreset', { body: { name: presetName.trim(), extensions: value } })).data,
    onSuccess: (preset) => {
      toast.success(`Saved preset ${preset.name}`);
      setPresetName('');
      setSaveOpen(false);
      void client.invalidateQueries({ queryKey: qk.presets });
    },
  });

  const deletePreset = useMutation({
    mutationFn: async (preset: ExtensionPreset) => {
      await api.call('deletePreset', { params: { id: preset.id } });
      return preset;
    },
    onSuccess: (preset) => {
      toast.success(`Deleted preset ${preset.name}`);
      void client.invalidateQueries({ queryKey: qk.presets });
    },
  });

  const selected = new Set(value);
  const togglePreset = (preset: ExtensionPreset) => {
    const applied = preset.extensions.every((e) => selected.has(e));
    if (applied) {
      const remove = new Set(preset.extensions);
      onChange(value.filter((e) => !remove.has(e)));
    } else {
      onChange(uniq([...value, ...preset.extensions]).slice(0, MAX_EXTENSIONS));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-md bg-input p-1.5">
        {value.map((ext) => (
          <span key={ext} className={cn(chipClass, 'bg-background pr-0.5')}>
            .{ext}
            <button
              type="button"
              aria-label={`Remove .${ext}`}
              onClick={() => onChange(value.filter((e) => e !== ext))}
              className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          aria-label="Add extensions"
          aria-invalid={invalid.length > 0 || undefined}
          aria-describedby={invalid.length ? `${inputId}-error` : undefined}
          value={draft}
          placeholder={value.length ? '' : 'com, io, co.uk'}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            const next = event.target.value;
            if (/[\s,;]$/.test(next) && next.trim()) commit(next);
            else setDraft(next);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit(draft);
            } else if (event.key === 'Backspace' && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => draft.trim() && commit(draft)}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
            if (/[\s,;]/.test(text.trim())) {
              event.preventDefault();
              commit(draft + text);
            }
          }}
          className="h-7 min-w-28 flex-1 bg-transparent px-1.5 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
        />
      </div>
      {invalid.length ? (
        <p id={`${inputId}-error`} className="text-xs text-negative">
          Not an extension: {invalid.join(', ')}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5" aria-label="Presets" role="group">
        {presets.isPending ? (
          <>
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-7 w-16" />
          </>
        ) : presets.isError ? (
          <span className="text-xs text-muted-foreground">Presets unavailable</span>
        ) : (
          presets.data.map((preset) => (
            <PresetChip
              key={preset.id}
              preset={preset}
              applied={preset.extensions.length > 0 && preset.extensions.every((e) => selected.has(e))}
              onToggle={() => togglePreset(preset)}
              onDelete={preset.builtIn ? undefined : () => deletePreset.mutate(preset)}
            />
          ))
        )}
        {value.length > 0 ? (
          <Popover open={saveOpen} onOpenChange={setSaveOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="quiet" className="h-7 px-2">
                <Plus />
                Save preset
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64">
              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (presetName.trim()) createPreset.mutate();
                }}
              >
                <Input autoFocus aria-label="Preset name" placeholder="Name" maxLength={100} value={presetName} onChange={(e) => setPresetName(e.target.value)} />
                <Button type="submit" size="sm" variant="primary" disabled={!presetName.trim() || createPreset.isPending}>
                  Save {value.length} extensions
                </Button>
              </form>
            </PopoverContent>
          </Popover>
        ) : null}
        {value.length > 0 ? (
          <Button size="sm" variant="quiet" className="h-7 px-2" onClick={() => onChange([])}>
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}
