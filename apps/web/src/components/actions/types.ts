import type { ExportCreate } from '@domain-scout/contracts';


export type ScopeInput = ExportCreate['scope'];


export interface DomainTarget {

  count: number;

  resolveDomains: () => Promise<string[]>;
}

export interface ScopeOption {
  value: string;
  label: string;

  build: () => Promise<ScopeInput>;
  disabled?: boolean;
}
