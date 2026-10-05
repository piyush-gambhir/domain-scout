'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDownNarrowWide, ArrowUpWideNarrow, ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react';
import type { ConfirmationStatus, JobOperation, ResultFilter } from '@domain-scout/contracts';
import { formatMoney } from '@/lib/format';
import { confirmationStatus, outcomeStatus } from '@/lib/labels';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Field } from '../ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Segmented } from '../ui/segmented';
import { Select } from '../ui/select';

export type Sort = NonNullable<ResultFilter['sort']>;

const SORTS: { value: Sort; label: string }[] = [
  { value: 'input', label: 'Input order' },
  { value: 'domain', label: 'Domain' },
  { value: 'suffix', label: 'Extension' },
  { value: 'length', label: 'Length' },
  { value: 'outcome', label: 'Outcome' },
  { value: 'checkedAt', label: 'Checked' },
  { value: 'price', label: 'Price' },
  { value: 'confirmation', label: 'Provider confirmation' },
];

const LIST_KEYS = ['outcomes', 'suffixes', 'states', 'confirmations'] as const;

const CONFIRMATIONS: ConfirmationStatus[] = ['available', 'unavailable', 'restricted', 'unknown'];

/** Provider confirmation choices; registry rows match on the newest confirmation for their domain. */
export const CONFIRMATION_OPTIONS = CONFIRMATIONS.map((value) => ({ value, label: confirmationStatus(value).label }));

/** URL search params <-> ResultFilter. Lists are comma separated, like the API query form. */
export function filterFromParams(params: URLSearchParams): ResultFilter {
  const filter: ResultFilter = {};
  const q = params.get('q');
  if (q) filter.q = q;
  for (const key of LIST_KEYS) {
    const value = params.get(key);
    if (value) (filter as Record<string, unknown>)[key] = value.split(',').filter(Boolean);
  }
  const resolved = params.get('resolved');
  if (resolved === 'true' || resolved === 'false') filter.resolved = resolved === 'true';
  const maxLength = Number(params.get('maxLength'));
  if (Number.isInteger(maxLength) && maxLength > 0 && maxLength <= 63) filter.maxLength = maxLength;
  const maxPrice = params.get('maxPrice');
  if (maxPrice && /^\d+(\.\d+)?$/.test(maxPrice)) filter.maxPrice = maxPrice;
  const currency = params.get('priceCurrency');
  if (currency && /^[A-Z]{3}$/.test(currency)) filter.priceCurrency = currency;
  const collectionId = params.get('collectionId');
  if (collectionId) filter.collectionId = collectionId;
  const inCollection = params.get('inCollection');
  if (inCollection === 'true' || inCollection === 'false') filter.inCollection = inCollection === 'true';
  const sort = params.get('sort');
  if (sort && SORTS.some((s) => s.value === sort)) filter.sort = sort as Sort;
  const order = params.get('order');
  if (order === 'asc' || order === 'desc') filter.order = order;
  return filter;
}

export function filterToParams(filter: ResultFilter, base: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const key of ['q', ...LIST_KEYS, 'resolved', 'maxLength', 'maxPrice', 'priceCurrency', 'collectionId', 'inCollection', 'sort', 'order']) params.delete(key);
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(','));
    } else params.set(key, String(value));
  }
  return params;
}

/** Same filter in the API's query-string form. */
export function filterToQuery(filter: ResultFilter) {
  return {
    q: filter.q,
    outcomes: filter.outcomes?.join(','),
    suffixes: filter.suffixes?.join(','),
    states: filter.states?.join(','),
    confirmations: filter.confirmations?.join(','),
    resolved: filter.resolved === undefined ? undefined : filter.resolved ? ('true' as const) : ('false' as const),
    maxLength: filter.maxLength,
    maxPrice: filter.maxPrice,
    priceCurrency: filter.priceCurrency,
    collectionId: filter.collectionId,
    inCollection: filter.inCollection === undefined ? undefined : filter.inCollection ? ('true' as const) : ('false' as const),
    sort: filter.sort,
    order: filter.order,
  };
}

/** Short human description of a filter, e.g. for saved criteria. Empty when nothing narrows or sorts. */
export function describeFilter(filter: ResultFilter, operation: JobOperation = 'registry'): string[] {
  const parts: string[] = [];
  if (filter.q) parts.push(`Matching "${filter.q}"`);
  if (filter.outcomes?.length) parts.push(`Outcome ${filter.outcomes.map((o) => outcomeStatus(operation, o).label).join(', ')}`);
  if (filter.suffixes?.length) parts.push(filter.suffixes.map((s) => `.${s}`).join(' '));
  if (filter.confirmations?.length) parts.push(`Provider ${filter.confirmations.map((c) => confirmationStatus(c).label).join(', ')}`);
  if (filter.resolved !== undefined) parts.push(filter.resolved ? 'Resolved only' : 'Unresolved only');
  if (filter.maxLength) parts.push(`Up to ${filter.maxLength} characters`);
  if (filter.maxPrice) parts.push(`At most ${formatMoney(filter.maxPrice, filter.priceCurrency ?? 'USD')}`);
  if (filter.collectionId) parts.push('In one shortlist');
  if (filter.inCollection !== undefined) parts.push(filter.inCollection ? 'Shortlisted' : 'Not shortlisted');
  if (filter.sort && filter.sort !== 'input') {
    parts.push(`Sorted by ${SORTS.find((s) => s.value === filter.sort)?.label.toLowerCase() ?? filter.sort}${filter.order === 'desc' ? ', descending' : ''}`);
  }
  return parts;
}

export function isFiltered(filter: ResultFilter): boolean {
  return Boolean(
    filter.q ||
      filter.outcomes?.length ||
      filter.suffixes?.length ||
      filter.states?.length ||
      filter.confirmations?.length ||
      filter.resolved !== undefined ||
      filter.maxLength ||
      filter.maxPrice ||
      filter.collectionId ||
      filter.inCollection !== undefined,
  );
}

export function MultiSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string[] | undefined;
  onChange: (value: string[] | undefined) => void;
}) {
  const selected = new Set(value ?? []);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant={selected.size ? 'primary' : 'secondary'}>
          {label}
          {selected.size ? <span className="font-mono text-xs tabular">{selected.size}</span> : null}
          <ChevronDown className="opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-1">
        <CheckList idPrefix={`ms-${label}`} options={options} selected={selected} onChange={onChange} />
        {selected.size ? (
          <Button size="sm" variant="quiet" className="mt-1 w-full" onClick={() => onChange(undefined)}>
            Clear
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function CheckList({
  idPrefix,
  options,
  selected,
  onChange,
}: {
  idPrefix: string;
  options: { value: string; label: string }[];
  selected: Set<string>;
  onChange: (value: string[] | undefined) => void;
}) {
  if (options.length === 0) return <p className="p-2 text-sm text-muted-foreground">No options.</p>;
  return (
    <ul className="flex flex-col">
      {options.map((option) => {
        const id = `${idPrefix}-${option.value}`;
        return (
          <li key={option.value}>
            <label htmlFor={id} className="flex h-8 items-center gap-2.5 rounded-md px-2 text-sm hover:bg-hover">
              <Checkbox
                id={id}
                checked={selected.has(option.value)}
                onCheckedChange={(checked) => {
                  const next = new Set(selected);
                  if (checked === true) next.add(option.value);
                  else next.delete(option.value);
                  onChange(next.size ? [...next] : undefined);
                }}
              />
              <span className="truncate">{option.label}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

const groupLabel = 'mb-1 text-xs font-medium text-muted-foreground';

function MoreFiltersBody({
  filter,
  onChange,
  collections,
  showConfirmations,
}: {
  filter: ResultFilter;
  onChange: (patch: Partial<ResultFilter>) => void;
  collections: { value: string; label: string }[];
  showConfirmations: boolean;
}) {
  // Mounted only while the popover is open, so the draft always starts from the active filter.
  const [maxPrice, setMaxPrice] = useState(filter.maxPrice ?? '');
  const priceInvalid = maxPrice !== '' && !/^\d+(\.\d+)?$/.test(maxPrice);
  const resolved = filter.resolved === undefined ? 'all' : filter.resolved ? 'resolved' : 'unresolved';
  return (
    <>
      <div>
        <p className={groupLabel}>Resolution</p>
        <Segmented
          aria-label="Resolution"
          value={resolved}
          onValueChange={(value) => onChange({ resolved: value === 'all' ? undefined : value === 'resolved' })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'unresolved', label: 'Unresolved' },
          ]}
        />
      </div>
      {showConfirmations || filter.confirmations?.length ? (
        <fieldset>
          <legend className={groupLabel}>Provider confirmation</legend>
          <div className="-mx-2">
            <CheckList
              idPrefix="f-confirmation"
              options={CONFIRMATION_OPTIONS}
              selected={new Set(filter.confirmations ?? [])}
              onChange={(confirmations) => onChange({ confirmations: confirmations as ConfirmationStatus[] | undefined })}
            />
          </div>
        </fieldset>
      ) : null}
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_4.5rem] gap-2">
        <Field label="Max length" htmlFor="f-maxlen">
          <Input
            id="f-maxlen"
            type="number"
            inputMode="numeric"
            min={1}
            max={63}
            value={filter.maxLength ?? ''}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange({ maxLength: e.target.value && Number.isInteger(n) && n >= 1 && n <= 63 ? n : undefined });
            }}
          />
        </Field>
        <Field label="Max first-year price" htmlFor="f-maxprice">
          <Input
            id="f-maxprice"
            inputMode="decimal"
            value={maxPrice}
            aria-invalid={priceInvalid || undefined}
            onChange={(e) => {
              setMaxPrice(e.target.value);
              if (e.target.value === '') onChange({ maxPrice: undefined });
              else if (/^\d+(\.\d+)?$/.test(e.target.value)) onChange({ maxPrice: e.target.value });
            }}
            className="font-mono"
          />
        </Field>
        <Field label="Currency" htmlFor="f-currency">
          <Input
            id="f-currency"
            defaultValue={filter.priceCurrency ?? ''}
            maxLength={3}
            placeholder="USD"
            onChange={(e) => {
              const value = e.target.value.toUpperCase();
              onChange({ priceCurrency: /^[A-Z]{3}$/.test(value) ? value : undefined });
            }}
            className="font-mono uppercase"
          />
        </Field>
      </div>
      <Field label="Shortlist" htmlFor="f-collection">
        <Select
          id="f-collection"
          value={filter.collectionId ?? (filter.inCollection === undefined ? '__any__' : filter.inCollection ? '__in__' : '__out__')}
          onValueChange={(value) =>
            onChange({
              collectionId: value.startsWith('__') ? undefined : value,
              inCollection: value === '__in__' ? true : value === '__out__' ? false : undefined,
            })
          }
          options={[
            { value: '__any__', label: 'Any' },
            { value: '__in__', label: 'In any shortlist' },
            { value: '__out__', label: 'Not shortlisted' },
            ...collections,
          ]}
        />
      </Field>
    </>
  );
}

/** Less common filters: resolution, provider confirmation, length, price cap and shortlist. */
function MoreFilters({
  filter,
  onChange,
  collections,
  showConfirmations,
}: {
  filter: ResultFilter;
  onChange: (patch: Partial<ResultFilter>) => void;
  collections: { value: string; label: string }[];
  showConfirmations: boolean;
}) {
  const active = [
    filter.resolved !== undefined,
    filter.confirmations?.length,
    filter.maxLength,
    filter.maxPrice,
    filter.collectionId || filter.inCollection !== undefined,
  ].filter(Boolean).length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant={active ? 'primary' : 'secondary'} aria-label={active ? `More filters, ${active} active` : 'More filters'}>
          <SlidersHorizontal />
          More
          {active ? <span className="font-mono text-xs tabular">{active}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex w-80 flex-col gap-4 p-3">
        <MoreFiltersBody filter={filter} onChange={onChange} collections={collections} showConfirmations={showConfirmations} />
      </PopoverContent>
    </Popover>
  );
}

/** Search, the common filters, the result count and sort in one row. */
export function ResultFilters({
  filter,
  onChange,
  outcomeOptions,
  suffixOptions,
  showConfirmations,
  collections,
  searchRef,
  count,
}: {
  filter: ResultFilter;
  onChange: (patch: Partial<ResultFilter>) => void;
  outcomeOptions: { value: string; label: string }[];
  suffixOptions: { value: string; label: string }[];
  /** Domain results only: name checks and catalog refreshes have no provider confirmations. */
  showConfirmations: boolean;
  collections: { value: string; label: string }[];
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** "1,500 results", shown before the sort control. */
  count: React.ReactNode;
}) {
  const [q, setQ] = useState(filter.q ?? '');
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    const timer = setTimeout(() => onChangeRef.current({ q: q.trim() || undefined }), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const order = filter.order ?? 'asc';

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5" role="search" aria-label="Filter results">
      <div className="relative w-full sm:w-44 xl:w-56">
        <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input ref={searchRef} type="search" aria-label="Search results" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
      </div>
      <MultiSelect label="Outcome" options={outcomeOptions} value={filter.outcomes} onChange={(outcomes) => onChange({ outcomes })} />
      <MultiSelect label="Extension" options={suffixOptions} value={filter.suffixes} onChange={(suffixes) => onChange({ suffixes })} />
      <MoreFilters filter={filter} onChange={onChange} collections={collections} showConfirmations={showConfirmations} />
      {isFiltered(filter) ? (
        <Button
          size="sm"
          variant="quiet"
          aria-label="Clear filters"
          onClick={() => {
            setQ('');
            onChange({
              q: undefined,
              outcomes: undefined,
              suffixes: undefined,
              states: undefined,
              confirmations: undefined,
              resolved: undefined,
              maxLength: undefined,
              maxPrice: undefined,
              priceCurrency: undefined,
              collectionId: undefined,
              inCollection: undefined,
            });
          }}
        >
          <X />
          Clear
        </Button>
      ) : null}
      <div className="ml-auto flex items-center gap-1.5">
        <span className="whitespace-nowrap px-1 text-sm text-muted-foreground tabular" aria-live="polite">
          {count}
        </span>
        <Select aria-label="Sort by" value={filter.sort ?? 'input'} onValueChange={(sort) => onChange({ sort: sort as Sort })} options={SORTS} className="w-32" />
        <Button
          size="icon"
          variant="secondary"
          aria-label={order === 'asc' ? 'Ascending, switch to descending' : 'Descending, switch to ascending'}
          onClick={() => onChange({ order: order === 'asc' ? 'desc' : 'asc' })}
        >
          {order === 'asc' ? <ArrowDownNarrowWide /> : <ArrowUpWideNarrow />}
        </Button>
      </div>
    </div>
  );
}
