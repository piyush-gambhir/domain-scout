import type {
  CreateJobRequestParsed,
  InputPreview,
  InputSourceParsed,
  Job,
  NormalizedDomain,
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
}

/** Implemented by JobsModule. Validates, plans items, persists and starts the job. */
export abstract class JobSubmitter {
  abstract submit(request: CreateJobRequestParsed | WatchJobRequest | CatalogJobRequest, options?: SubmitOptions): Job;
  abstract get(jobId: string): Job;
}
