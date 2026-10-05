'use client';

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import type { FxRate, Resolver, Settings } from '@domain-scout/contracts';
import { formatInterval } from '@/lib/format';
import { type SettingsPatchInput, usePatchSettings, useSettings } from '@/lib/queries';
import { type ThemeChoice, useThemePreference } from '@/lib/theme';
import { ErrorState, SectionTitle } from '../states';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Field } from '../ui/label';
import { Segmented } from '../ui/segmented';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { SwitchField } from '../ui/switch';

/** Loads settings once for a section; sections render their form only with data. */
function WithSettings({ children }: { children: (settings: Settings) => React.ReactNode }) {
  const settings = useSettings();
  if (settings.isPending) return <Skeleton className="h-64 max-w-2xl" />;
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  return <>{children(settings.data)}</>;
}

/** Submit and discard for a section form; the form's onSubmit saves. */
function SaveBar({ dirty, valid, pending, onDiscard }: { dirty: boolean; valid: boolean; pending: boolean; onDiscard: () => void }) {
  return (
    <div className="mt-8 flex gap-2">
      <Button type="submit" variant="primary" disabled={!dirty || !valid || pending}>
        Save
      </Button>
      {dirty ? (
        <Button variant="ghost" onClick={onDiscard}>
          Discard
        </Button>
      ) : null}
    </div>
  );
}

export function AppearanceSettings() {
  const { theme, setTheme } = useThemePreference();
  return (
    <section aria-label="Appearance">
      <SectionTitle>Appearance</SectionTitle>
      <div className="flex flex-col items-start gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Theme</span>
        <Segmented<ThemeChoice>
          aria-label="Theme"
          value={theme}
          onValueChange={setTheme}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </div>
    </section>
  );
}

interface NumberSpec {
  key: string;
  label: string;
  unit: string;
  min: number;
  max?: number;
  get: (s: Settings) => number;
  patch: (value: number) => SettingsPatchInput;
}

const CHECK_FIELDS: { group: string; fields: NumberSpec[] }[] = [
  {
    group: 'Concurrency',
    fields: [
      { key: 'global', label: 'Checks in flight', unit: 'checks', min: 1, max: 64, get: (s) => s.concurrency.global, patch: (v) => ({ concurrency: { global: v } }) },
      { key: 'perSource', label: 'At once per source', unit: 'checks', min: 1, max: 8, get: (s) => s.concurrency.perSource, patch: (v) => ({ concurrency: { perSource: v } }) },
      { key: 'minSourceIntervalMs', label: 'Spacing per source', unit: 'ms', min: 0, max: 60_000, get: (s) => s.concurrency.minSourceIntervalMs, patch: (v) => ({ concurrency: { minSourceIntervalMs: v } }) },
      { key: 'maxCooldownWaitSeconds', label: 'Longest cooldown wait', unit: 'seconds', min: 0, max: 86_400, get: (s) => s.concurrency.maxCooldownWaitSeconds, patch: (v) => ({ concurrency: { maxCooldownWaitSeconds: v } }) },
    ],
  },
  {
    group: 'Retries',
    fields: [
      { key: 'maxAttempts', label: 'Attempts', unit: 'attempts', min: 1, max: 5, get: (s) => s.retries.maxAttempts, patch: (v) => ({ retries: { maxAttempts: v } }) },
      { key: 'timeoutMs', label: 'Timeout', unit: 'ms', min: 1000, max: 120_000, get: (s) => s.retries.timeoutMs, patch: (v) => ({ retries: { timeoutMs: v } }) },
    ],
  },
  {
    group: 'Freshness',
    fields: [
      { key: 'registryMinutes', label: 'Registry evidence stale after', unit: 'minutes', min: 1, get: (s) => s.freshness.registryMinutes, patch: (v) => ({ freshness: { registryMinutes: v } }) },
      { key: 'catalogHours', label: 'Published prices stale after', unit: 'hours', min: 1, get: (s) => s.freshness.catalogHours, patch: (v) => ({ freshness: { catalogHours: v } }) },
      { key: 'quoteMinutes', label: 'Quotes stale after', unit: 'minutes', min: 1, get: (s) => s.freshness.quoteMinutes, patch: (v) => ({ freshness: { quoteMinutes: v } }) },
    ],
  },
  {
    group: 'Monitoring',
    fields: [
      { key: 'defaultIntervalMinutes', label: 'Default watch interval', unit: 'minutes', min: 15, get: (s) => s.monitoring.defaultIntervalMinutes, patch: (v) => ({ monitoring: { defaultIntervalMinutes: v } }) },
    ],
  },
];
const ALL_FIELDS = CHECK_FIELDS.flatMap((g) => g.fields);

/** Deep-merges partial patches section by section. */
function mergePatches(patches: SettingsPatchInput[]): SettingsPatchInput {
  const out: Record<string, Record<string, unknown>> = {};
  for (const patch of patches) {
    for (const [section, values] of Object.entries(patch)) out[section] = { ...(out[section] ?? {}), ...(values as Record<string, unknown>) };
  }
  return out as SettingsPatchInput;
}

function ChecksForm({ settings }: { settings: Settings }) {
  const save = usePatchSettings();
  const initial = Object.fromEntries(ALL_FIELDS.map((f) => [f.key, String(f.get(settings))]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [resolver, setResolver] = useState<Resolver>(settings.diagnostics.resolver);

  const parsed = ALL_FIELDS.map((field) => {
    const raw = values[field.key] ?? '';
    const n = /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
    const valid = Number.isInteger(n) && n >= field.min && (field.max === undefined || n <= field.max);
    return { field, value: n, valid, changed: valid && n !== field.get(settings) };
  });
  const valid = parsed.every((p) => p.valid);
  const dirty = parsed.some((p) => p.changed) || resolver !== settings.diagnostics.resolver;

  const submit = () => {
    const patches = parsed.filter((p) => p.changed).map((p) => p.field.patch(p.value));
    if (resolver !== settings.diagnostics.resolver) patches.push({ diagnostics: { resolver } });
    save.mutate(mergePatches(patches), { onSuccess: () => toast.success('Settings saved') });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-8">
        {CHECK_FIELDS.map((group) => (
          <fieldset key={group.group}>
            <legend className="mb-3 text-xs font-medium text-muted-foreground">{group.group}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {group.fields.map((field) => {
                const state = parsed.find((p) => p.field.key === field.key)!;
                const range = field.max === undefined ? `at least ${field.min}` : `${field.min} to ${field.max}`;
                const hint = !state.valid ? (
                  <span className="text-negative">Whole number, {range}</span>
                ) : field.key === 'defaultIntervalMinutes' ? (
                  `${field.unit}, ${formatInterval(state.value).toLowerCase()}`
                ) : (
                  field.unit
                );
                return (
                  <Field key={field.key} label={field.label} htmlFor={`set-${field.key}`} hint={hint}>
                    <Input
                      id={`set-${field.key}`}
                      inputMode="numeric"
                      value={values[field.key] ?? ''}
                      aria-invalid={!state.valid || undefined}
                      onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                      className="font-mono"
                    />
                  </Field>
                );
              })}
            </div>
          </fieldset>
        ))}
        <fieldset>
          <legend className="mb-3 text-xs font-medium text-muted-foreground">Diagnostics</legend>
          <div className="flex flex-col items-start gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">DNS resolver</span>
            <Segmented<Resolver>
              aria-label="DNS resolver"
              value={resolver}
              onValueChange={setResolver}
              options={[
                { value: 'system', label: 'System' },
                { value: 'cloudflare', label: 'Cloudflare' },
                { value: 'google', label: 'Google' },
              ]}
            />
          </div>
        </fieldset>
      </div>
      <SaveBar
        dirty={dirty}
        valid={valid}
        pending={save.isPending}
        onDiscard={() => {
          setValues(initial);
          setResolver(settings.diagnostics.resolver);
        }}
      />
    </form>
  );
}

export function ChecksSettings() {
  return (
    <section aria-label="Checks">
      <SectionTitle>Checks</SectionTitle>
      <WithSettings>{(settings) => <ChecksForm key={JSON.stringify([settings.concurrency, settings.retries, settings.freshness, settings.monitoring, settings.diagnostics])} settings={settings} />}</WithSettings>
    </section>
  );
}

interface RateDraft {
  id: number;
  from: string;
  to: string;
  rate: string;
  source: string;
  /** datetime-local value shown in the form (minute precision). */
  observedAt: string;
  /** The saved timestamp, kept exactly until the observed field is edited. */
  savedObservedAt: string | null;
}

/** ISO timestamp to a datetime-local value in the browser's time zone. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sentence(parts: string[]): string {
  const text = parts.join(', ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function rateIssues(rate: RateDraft): string[] {
  const issues: string[] = [];
  if (!/^[A-Z]{3}$/.test(rate.from) || !/^[A-Z]{3}$/.test(rate.to)) issues.push('currencies are three-letter codes');
  else if (rate.from === rate.to) issues.push('currencies differ');
  if (!/^\d+(\.\d+)?$/.test(rate.rate) || Number(rate.rate) <= 0) issues.push('rate is a positive decimal');
  if (!rate.source.trim()) issues.push('source is required');
  if (!rate.observedAt || Number.isNaN(new Date(rate.observedAt).getTime())) issues.push('observed time is required');
  return issues;
}

function PricingForm({ settings }: { settings: Settings }) {
  const save = usePatchSettings();
  const initialRates: RateDraft[] = settings.fxRates.map((r, i) => ({
    id: i,
    from: r.from,
    to: r.to,
    rate: r.rate,
    source: r.source,
    observedAt: toLocalInput(r.observedAt),
    savedObservedAt: r.observedAt,
  }));
  const [horizon, setHorizon] = useState(settings.comparison.horizonYears);
  const [currency, setCurrency] = useState(settings.comparison.currency ?? '');
  const [rates, setRates] = useState<RateDraft[]>(initialRates);
  const [nextId, setNextId] = useState(initialRates.length);

  const currencyValid = currency === '' || /^[A-Z]{3}$/.test(currency);
  const issues = rates.map(rateIssues);
  const valid = currencyValid && issues.every((i) => i.length === 0);
  const toContract = (r: RateDraft): FxRate => ({
    from: r.from,
    to: r.to,
    rate: r.rate,
    source: r.source.trim(),
    observedAt: r.savedObservedAt ?? new Date(r.observedAt).toISOString(),
  });
  const ratesChanged = rates.length !== settings.fxRates.length || (valid && JSON.stringify(rates.map(toContract)) !== JSON.stringify(settings.fxRates));
  const comparisonChanged = horizon !== settings.comparison.horizonYears || currency !== (settings.comparison.currency ?? '');
  const dirty = comparisonChanged || ratesChanged;

  const update = (id: number, patch: Partial<RateDraft>) => setRates((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <form
      className="max-w-3xl"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        // Send only what changed, so untouched rates keep their exact saved timestamps.
        save.mutate(
          {
            ...(comparisonChanged ? { comparison: { horizonYears: horizon, currency: currency || null } } : {}),
            ...(ratesChanged ? { fxRates: rates.map(toContract) } : {}),
          },
          { onSuccess: () => toast.success('Pricing saved') },
        );
      }}
    >
      <div className="grid max-w-md gap-4 sm:grid-cols-2">
        <Field label="Ownership horizon" htmlFor="set-horizon">
          <Select
            id="set-horizon"
            value={String(horizon)}
            onValueChange={(v) => setHorizon(Number(v))}
            options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} year${i ? 's' : ''}` }))}
          />
        </Field>
        <Field label="Comparison currency" htmlFor="set-currency" hint={currencyValid ? (currency ? 'Needs an exchange rate below' : 'Original currencies') : <span className="text-negative">Three-letter code</span>}>
          <Input
            id="set-currency"
            value={currency}
            maxLength={3}
            placeholder="None"
            aria-invalid={!currencyValid || undefined}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            className="font-mono uppercase placeholder:normal-case"
          />
        </Field>
      </div>

      <fieldset className="mt-10">
        <legend className="mb-3 text-xs font-medium text-muted-foreground">Exchange rates</legend>
        {rates.length === 0 ? <p className="mb-3 text-sm text-muted-foreground">No exchange rates.</p> : null}
        <ul className="flex flex-col gap-4" aria-label="Exchange rates">
          {rates.map((rate, index) => (
            <li key={rate.id} className="rounded-lg bg-hover/60 p-3" data-testid="fx-rate">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-[5rem_5rem_7rem_minmax(0,1fr)_12rem_auto] sm:items-end">
                <Field label="From" htmlFor={`fx-from-${rate.id}`}>
                  <Input id={`fx-from-${rate.id}`} value={rate.from} maxLength={3} onChange={(e) => update(rate.id, { from: e.target.value.toUpperCase() })} className="font-mono uppercase" />
                </Field>
                <Field label="To" htmlFor={`fx-to-${rate.id}`}>
                  <Input id={`fx-to-${rate.id}`} value={rate.to} maxLength={3} onChange={(e) => update(rate.id, { to: e.target.value.toUpperCase() })} className="font-mono uppercase" />
                </Field>
                <Field label="Rate" htmlFor={`fx-rate-${rate.id}`}>
                  <Input id={`fx-rate-${rate.id}`} inputMode="decimal" value={rate.rate} onChange={(e) => update(rate.id, { rate: e.target.value.trim() })} className="font-mono" />
                </Field>
                <Field label="Source" htmlFor={`fx-source-${rate.id}`}>
                  <Input id={`fx-source-${rate.id}`} value={rate.source} maxLength={200} onChange={(e) => update(rate.id, { source: e.target.value })} />
                </Field>
                <Field label="Observed" htmlFor={`fx-observed-${rate.id}`}>
                  <Input id={`fx-observed-${rate.id}`} type="datetime-local" value={rate.observedAt} onChange={(e) => update(rate.id, { observedAt: e.target.value, savedObservedAt: null })} />
                </Field>
                <Button size="icon" variant="quiet" aria-label={`Remove rate ${index + 1}`} onClick={() => setRates((list) => list.filter((r) => r.id !== rate.id))} className="justify-self-end">
                  <X />
                </Button>
              </div>
              {issues[index]!.length > 0 ? (
                <p className="mt-2 text-xs text-negative">{sentence(issues[index]!)}</p>
              ) : null}
            </li>
          ))}
        </ul>
        <Button
          size="sm"
          variant="quiet"
          className="mt-3"
          onClick={() => {
            setRates((list) => [...list, { id: nextId, from: '', to: '', rate: '', source: '', observedAt: toLocalInput(new Date().toISOString()), savedObservedAt: null }]);
            setNextId((n) => n + 1);
          }}
        >
          <Plus />
          Add rate
        </Button>
      </fieldset>
      <SaveBar
        dirty={dirty}
        valid={valid}
        pending={save.isPending}
        onDiscard={() => {
          setHorizon(settings.comparison.horizonYears);
          setCurrency(settings.comparison.currency ?? '');
          setRates(initialRates);
        }}
      />
    </form>
  );
}

export function PricingSettings() {
  return (
    <section aria-label="Pricing">
      <SectionTitle>Pricing</SectionTitle>
      <WithSettings>{(settings) => <PricingForm key={JSON.stringify([settings.comparison, settings.fxRates])} settings={settings} />}</WithSettings>
    </section>
  );
}

export function PrivacySettings() {
  const save = usePatchSettings();
  return (
    <section aria-label="Privacy">
      <SectionTitle>Privacy</SectionTitle>
      <WithSettings>
        {(settings) => (
          <SwitchField
            id="set-raw"
            label="Keep sanitized raw registry responses"
            className="max-w-md"
            checked={settings.privacy.keepRawDiagnostics}
            disabled={save.isPending}
            onCheckedChange={(keepRawDiagnostics) => save.mutate({ privacy: { keepRawDiagnostics } }, { onSuccess: () => toast.success('Privacy saved') })}
          />
        )}
      </WithSettings>
    </section>
  );
}
