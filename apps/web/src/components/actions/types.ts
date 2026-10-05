import type { ExportCreate } from '@domain-scout/contracts';

/** Export or snapshot scope in request (input) form; the backend applies filter defaults. */
export type ScopeInput = ExportCreate['scope'];

/** What a bulk action operates on. Resolution may page through a filter, so it is async. */
export interface DomainTarget {
  /** Count shown in labels and disclosure lines (selected rows or domains). */
  count: number;
  /** Unique ASCII domains. */
  resolveDomains: () => Promise<string[]>;
}

export interface ScopeOption {
  value: string;
  label: string;
  /** Builds the export scope at submit time. */
  build: () => Promise<ScopeInput>;
  disabled?: boolean;
}
