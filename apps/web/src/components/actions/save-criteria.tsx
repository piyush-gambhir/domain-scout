'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import { type Budget, parseBudget } from '@/lib/criteria';
import { useProviders, useSettings } from '@/lib/queries';
import { MultiSelect } from '../jobs/filters';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogFooter } from '../ui/dialog';
import { Input } from '../ui/input';
import { Field } from '../ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { SkeletonRows } from '../ui/skeleton';

/** Budget amount and currency inputs. The amount is kept as typed; parseBudget validates it. */
export function BudgetFields({
  idPrefix,
  amount,
  currency,
  error,
  onChange,
}: {
  idPrefix: string;
  amount: string;
  currency: string;
  error: string | null;
  onChange: (patch: { amount?: string; currency?: string }) => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
      <Field label="Budget (first year)" htmlFor={`${idPrefix}-budget`} hint={error ? <span className="text-negative">{error}</span> : undefined}>
        <Input
          id={`${idPrefix}-budget`}
          inputMode="decimal"
          value={amount}
          aria-invalid={Boolean(error) || undefined}
          onChange={(e) => onChange({ amount: e.target.value })}
          className="font-mono"
        />
      </Field>
      <Field label="Currency" htmlFor={`${idPrefix}-currency`}>
        <Input
          id={`${idPrefix}-currency`}
          maxLength={3}
          placeholder="USD"
          value={currency}
          onChange={(e) => onChange({ currency: e.target.value.toUpperCase() })}
          className="font-mono uppercase"
        />
      </Field>
    </div>
  );
}

/** Compact provider multi-select for forms; selection only, nothing is sent to providers. */
export function ProviderPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const providers = useProviders();
  // Registry directory entries have no price or quote source, so only named registrars are offered.
  const options = (providers.data ?? [])
    .filter((p) => value.includes(p.id) || (p.enabled && p.kind === 'registrar'))
    .map((p) => ({ value: p.id, label: p.name }));
  return <MultiSelect label="Providers" options={options} value={value.length ? value : undefined} onChange={(ids) => onChange(ids ?? [])} />;
}

/** Name-only save control for pages whose criteria fields are already on the form. */
export function SaveCriteriaPopover({
  disabled,
  onSave,
  pending,
  label = 'Save criteria',
}: {
  disabled: boolean;
  onSave: (name: string) => Promise<unknown>;
  pending: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" disabled={disabled}>
          <Save />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled || !name.trim()) return;
            // Failures are reported by the global mutation handler; the popover stays open.
            void onSave(name.trim()).then(
              () => {
                setName('');
                setOpen(false);
              },
              () => undefined,
            );
          }}
        >
          <Input autoFocus aria-label={`${label} name`} placeholder="Name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" size="sm" variant="primary" disabled={disabled || !name.trim() || pending}>
            Save
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export interface CriteriaChoice {
  name: string;
  providerIds: string[];
  budget: Budget | null;
}

/** Mounted only while the dialog is open, so it always starts from the current view. */
function SaveCriteriaBody({
  summary,
  initialProviders,
  initialBudget,
  pending,
  onCancel,
  onSave,
}: {
  summary: React.ReactNode;
  initialProviders: string[];
  initialBudget: { amount: string; currency: string | null };
  pending: boolean;
  onCancel: () => void;
  onSave: (choice: CriteriaChoice) => void;
}) {
  const providers = useProviders();
  const settings = useSettings();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState(() => new Set(initialProviders));
  const [amount, setAmount] = useState(initialBudget.amount);
  const [currency, setCurrency] = useState<string | null>(initialBudget.currency);
  const shownCurrency = currency ?? settings.data?.comparison.currency ?? 'USD';
  const { budget, error } = parseBudget(amount, shownCurrency);
  const canSave = name.trim().length > 0 && !error && !pending;
  const list = (providers.data ?? []).filter((p) => selected.has(p.id) || (p.enabled && p.kind === 'registrar'));

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) onSave({ name: name.trim(), providerIds: list.filter((p) => selected.has(p.id)).map((p) => p.id), budget });
      }}
    >
      <Input id="criteria-name" aria-label="Criteria name" placeholder="Name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      <div className="text-sm text-muted-foreground">{summary}</div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground" id="criteria-providers">
          Providers
        </span>
        {providers.isPending ? (
          <SkeletonRows rows={3} />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">No enabled providers.</p>
        ) : (
          <ul className="flex flex-col gap-0.5" aria-labelledby="criteria-providers">
            {list.map((provider) => {
              const id = `criteria-provider-${provider.id}`;
              return (
                <li key={provider.id}>
                  <label htmlFor={id} className="flex h-9 items-center gap-3 rounded-md px-2 text-sm transition-colors hover:bg-hover">
                    <Checkbox
                      id={id}
                      checked={selected.has(provider.id)}
                      onCheckedChange={(value) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (value === true) next.add(provider.id);
                          else next.delete(provider.id);
                          return next;
                        })
                      }
                    />
                    <span className="truncate">{provider.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <BudgetFields
        idPrefix="criteria"
        amount={amount}
        currency={shownCurrency}
        error={error}
        onChange={(patch) => {
          if (patch.amount !== undefined) setAmount(patch.amount);
          if (patch.currency !== undefined) setCurrency(patch.currency);
        }}
      />
      <DialogFooter className="mt-1">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!canSave}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Saves the current results view as named criteria: its filter plus chosen providers and budget. */
export function SaveCriteriaDialog({
  open,
  onOpenChange,
  summary,
  initialProviders,
  initialBudget,
  pending,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: React.ReactNode;
  initialProviders: string[];
  initialBudget: { amount: string; currency: string | null };
  pending: boolean;
  onSave: (choice: CriteriaChoice) => Promise<unknown>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Save criteria"
        onOpenAutoFocus={(event) => {
          // Start in the name field rather than on the close button.
          event.preventDefault();
          document.getElementById('criteria-name')?.focus();
        }}
      >
        <SaveCriteriaBody
          summary={summary}
          initialProviders={initialProviders}
          initialBudget={initialBudget}
          pending={pending}
          onCancel={() => onOpenChange(false)}
          onSave={(choice) =>
            void onSave(choice).then(
              () => onOpenChange(false),
              () => undefined,
            )
          }
        />
      </DialogContent>
    </Dialog>
  );
}
