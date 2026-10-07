'use client';

import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Field } from '../ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Segmented } from '../ui/segmented';
import { SwitchField } from '../ui/switch';
import { OptionsTrigger } from './search-field';
import { type Format, type SearchOptions, optionsChanged } from './search-state';

/** Input format, CSV column, recheck and label: choices most searches never need. */
/** Saves the typed names and extensions as a named search to restore later from Saved. */
function SaveSearch({ onSave, saving }: { onSave: (name: string) => Promise<unknown>; saving: boolean }) {
  const [name, setName] = useState('');
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        void onSave(name.trim()).then(
          () => setName(''),
          () => undefined,
        );
      }}
    >
      <Field label="Save as a search" htmlFor="search-save-name" className="flex-1">
        <Input id="search-save-name" placeholder="Name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Button type="submit" size="sm" variant="secondary" disabled={!name.trim() || saving}>
        Save
      </Button>
    </form>
  );
}

export function SearchOptionsPopover({
  value,
  onChange,
  onSave,
  saving = false,
}: {
  value: SearchOptions;
  onChange: (next: SearchOptions) => void;
  onSave?: (name: string) => Promise<unknown>;
  saving?: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <OptionsTrigger changed={optionsChanged(value)} />
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-4 p-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Input format</span>
          <Segmented<Format>
            aria-label="Input format"
            size="sm"
            value={value.format}
            onValueChange={(format) => onChange({ ...value, format })}
            options={[
              { value: 'auto', label: 'Detect' },
              { value: 'lines', label: 'Names' },
              { value: 'csv', label: 'CSV' },
            ]}
          />
        </div>
        {value.format === 'csv' ? (
          <Field label="CSV column" htmlFor="search-csv-column">
            <Input id="search-csv-column" placeholder="First column" value={value.csvColumn} onChange={(e) => onChange({ ...value, csvColumn: e.target.value })} />
          </Field>
        ) : null}
        <SwitchField
          id="search-recheck"
          label="Check again instead of reusing recent results"
          checked={value.recheck}
          onCheckedChange={(recheck) => onChange({ ...value, recheck })}
        />
        <Field label="Label" htmlFor="search-label" hint="Shown in History. Left empty, the names are used.">
          <Input id="search-label" maxLength={200} value={value.label} onChange={(e) => onChange({ ...value, label: e.target.value })} />
        </Field>
        {onSave ? <SaveSearch onSave={onSave} saving={saving} /> : null}
      </PopoverContent>
    </Popover>
  );
}
