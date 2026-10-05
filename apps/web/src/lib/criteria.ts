import type { ResultFilter } from '@domain-scout/contracts';

/** Saved criteria budget: a decimal string and an ISO 4217 code, as in SavedCriteria.budget. */
export interface Budget {
  amount: string;
  currency: string;
}

const DECIMAL = /^\d+(\.\d+)?$/;
const CURRENCY = /^[A-Z]{3}$/;

/** Budget form fields to a Budget: null when the amount is empty, or a field error. */
export function parseBudget(amount: string, currency: string): { budget: Budget | null; error: string | null } {
  const value = amount.trim();
  const code = currency.trim().toUpperCase();
  if (!value) return { budget: null, error: null };
  if (!DECIMAL.test(value)) return { budget: null, error: 'Enter an amount such as 12.50.' };
  if (!CURRENCY.test(code)) return { budget: null, error: 'Enter a three-letter currency code.' };
  return { budget: { amount: value, currency: code }, error: null };
}

/** A budget is the results price cap: it sets maxPrice and priceCurrency on the filter. */
export function withBudget(filter: ResultFilter | null | undefined, budget: Budget | null): ResultFilter {
  const base: ResultFilter = { ...(filter ?? {}) };
  return budget ? { ...base, maxPrice: budget.amount, priceCurrency: budget.currency } : base;
}

/** Selected provider ids travel with a results view as `?providers=a,b`; they preselect provider requests. */
export const PROVIDERS_PARAM = 'providers';

export function providersFromParams(params: URLSearchParams): string[] {
  return (params.get(PROVIDERS_PARAM) ?? '').split(',').filter(Boolean);
}

/** Drops empty values and the default sort and order, so URLs and saved criteria stay minimal. */
export function compactFilter(filter: ResultFilter | null | undefined): ResultFilter {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter ?? {})) {
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    if ((key === 'sort' && value === 'input') || (key === 'order' && value === 'asc')) continue;
    out[key] = value;
  }
  return out as ResultFilter;
}

/** The filter without its price cap, for showing next to a budget that replaces it. */
export function withoutPrice(filter: ResultFilter): ResultFilter {
  const next = { ...filter };
  delete next.maxPrice;
  delete next.priceCurrency;
  return next;
}
