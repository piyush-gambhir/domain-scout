'use client';

import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { qk, usePresets } from '@/lib/queries';
import { cn, uniq } from '@/lib/utils';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGap, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

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

/** Free-entry field in a popover: type extensions, press Enter. */
function AddExtensions({ value, onChange, compact }: { value: string[]; onChange: (next: string[]) => void; compact?: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState<string[]>([]);
  const commit = () => {
    const parsed = parseExtensions(draft);
    setInvalid(parsed.invalid);
    if (parsed.valid.length) onChange(uniq([...value, ...parsed.valid]).slice(0, MAX_EXTENSIONS));
    if (parsed.invalid.length === 0) {
      setDraft('');
      setOpen(false);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setInvalid([]);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Add extensions"
          className={cn('grid place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground', compact ? 'size-7' : 'size-8')}
        >
          <Plus className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
        >
          <Input
            id={id}
            autoFocus
            aria-label="Extensions to add"
            aria-invalid={invalid.length > 0 || undefined}
            placeholder="net, org, co.uk"
            spellCheck={false}
            autoCapitalize="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="font-mono"
          />
          {invalid.length ? <p className="text-xs text-negative">Not an extension: {invalid.join(', ')}</p> : null}
          <Button type="submit" size="sm" variant="primary" disabled={!draft.trim()}>
            Add
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function SavePreset({ value, onDone }: { value: string[]; onDone: () => void }) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: async () => (await api.call('createPreset', { body: { name: name.trim(), extensions: value } })).data,
    onSuccess: (preset) => {
      toast.success(`Saved preset ${preset.name}`);
      void client.invalidateQueries({ queryKey: qk.presets });
      onDone();
    },
  });
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) create.mutate();
      }}
    >
      <Input autoFocus aria-label="Preset name" placeholder="Preset name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      <Button type="submit" size="sm" variant="primary" disabled={!name.trim() || create.isPending}>
        Save {value.length} extensions
      </Button>
    </form>
  );
}

/**
 * The extension set a search expands names across, as removable chips. "+" adds by typing; the preset
 * menu swaps in a saved set. Callers decide whether a change is remembered.
 */
export function ExtensionChips({ value, onChange, compact }: { value: string[]; onChange: (next: string[]) => void; compact?: boolean }) {
  const presets = usePresets();
  const [saving, setSaving] = useState(false);
  const chip = compact ? 'h-7 text-[13px]' : 'h-8 text-[13px]';
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label="Extensions">
      {value.map((ext) => (
        <span key={ext} className={cn('group/chip inline-flex items-center rounded-md bg-input pl-2 pr-0.5 font-mono text-foreground', chip)}>
          .{ext}
          <button
            type="button"
            aria-label={`Remove .${ext}`}
            onClick={() => onChange(value.filter((e) => e !== ext))}
            className="ml-0.5 grid size-6 place-items-center rounded text-muted-foreground opacity-60 transition hover:bg-selected hover:text-foreground hover:opacity-100 focus-visible:opacity-100 group-hover/chip:opacity-100"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <AddExtensions value={value} onChange={onChange} compact={compact} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn('inline-flex items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground', chip)}
          >
            Presets
            <ChevronDown className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {presets.isPending ? <DropdownMenuLabel>Loading</DropdownMenuLabel> : null}
          {(presets.data ?? []).map((preset) => (
            <DropdownMenuItem key={preset.id} onSelect={() => onChange(preset.extensions.slice(0, MAX_EXTENSIONS))} className="h-auto min-h-8 py-1.5">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{preset.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{preset.extensions.map((e) => `.${e}`).join(' ')}</span>
              </span>
            </DropdownMenuItem>
          ))}
          {value.length > 0 ? (
            <>
              <DropdownMenuGap />
              <DropdownMenuItem onSelect={() => setSaving(true)}>Save these as a preset</DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={saving} onOpenChange={setSaving}>
        <DialogContent title="Save preset">{saving ? <SavePreset value={value} onDone={() => setSaving(false)} /> : null}</DialogContent>
      </Dialog>
    </div>
  );
}
