import type {
  CreateJobRequestParsed,
  ExtensionPreset,
  InputPreview,
  InputSourceParsed,
  Job,
  JobItem,
  JobOrigin,
  NameCheckService,
  NormalizedDomain,
  ProviderReadiness,
  ResultFilterParsed,
} from '@domain-scout/contracts';

/**
 * Cross-module ports. Each abstract class is implemented by exactly one module and injected by
 * class token, so modules depend on these contracts rather than on each other's internals.
 */

/** Implemented by RegistryModule (input normalization). */
export abstract class InputPreviewer {
  abstract preview(source: InputSourceParsed): InputPreview;
  /** Normalize one complete domain; null when invalid or not a registrable domain. */
  abstract normalize(domain: string): NormalizedDomain | null;
  /** Built-in extension presets bundled with the backend. */
  abstract presets(): ExtensionPreset[];
}

/** Internal job request for a monitoring run; not part of the public CreateJobRequest. */
export interface WatchJobRequest {
  type: 'watch';
  watchId: string;
  label?: string;
  domains: string[];
  includeRegistry: boolean;
  providerIds: string[];
  includeCatalogPrices: boolean;
}

/** Internal job request for refreshing provider catalogs (no candidate names). */
export interface CatalogJobRequest {
  type: 'catalog_refresh';
  providerIds: string[];
  label?: string;
}

export interface SubmitOptions {
  idempotencyKey?: string;
  /** Operation id used to scope idempotency keys, e.g. createJob or createQuotes. */
  operationId?: string;
  watchId?: string;
  parentJobId?: string;
  /** Who started the job; defaults by type (watch, system) or to api. */
  origin?: JobOrigin;
}

/** Implemented by JobsModule. Validates, plans items, persists and starts the job. */
export abstract class JobSubmitter {
  abstract submit(request: CreateJobRequestParsed | WatchJobRequest | CatalogJobRequest, options?: SubmitOptions): Job;
  abstract get(jobId: string): Job;
}

/** Implemented by JobsModule. Notifies after a job reaches a terminal state (committed). */
export abstract class JobLifecycle {
  abstract onFinished(listener: (job: Job) => void): () => void;
}

/** Implemented by JobsModule. The one filter/sort implementation shared by results, CLI and exports. */
export abstract class JobResults {
  abstract list(
    jobId: string,
    filter: ResultFilterParsed,
    cursor?: string | null,
    limit?: number,
  ): { items: JobItem[]; nextCursor: string | null; total: number };
  /** Every item id matching the filter, in result order (for exports resolved at creation time). */
  abstract matchingIds(jobId: string, filter: ResultFilterParsed): string[];
  /** Items by id, in the given order; unknown ids are skipped. */
  abstract byIds(itemIds: string[]): JobItem[];
}

/** Implemented by RegistryModule. */
export abstract class CoverageReader {
  abstract counts(): { tested: number; discovered: number; unsupported: number };
}

export interface SuffixProvider {
  providerId: string;
  name: string;
  supportsSuffix: 'yes' | 'no' | 'unknown';
  purchaseUrl: string | null;
  purchaseKind: 'search' | 'dashboard' | 'website' | null;
  enabled: boolean;
  preferred: boolean;
}

/** Implemented by ProvidersModule. */
export abstract class ProviderDirectory {
  abstract summary(): { id: string; name: string; readiness: ProviderReadiness }[];
  /** Providers for a domain's suffix with matching purchase destinations (same provider, same path). */
  abstract forDomain(domain: string, suffix: string): SuffixProvider[];
  abstract exists(providerId: string): boolean;
}

/** Implemented by EnrichmentModule. */
export abstract class NameCheckCatalog {
  abstract services(): NameCheckService[];
}
