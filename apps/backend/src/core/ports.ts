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







export abstract class InputPreviewer {
  abstract preview(source: InputSourceParsed): InputPreview;

  abstract normalize(domain: string): NormalizedDomain | null;

  abstract presets(): ExtensionPreset[];
}


export interface WatchJobRequest {
  type: 'watch';
  watchId: string;
  label?: string;
  domains: string[];
  includeRegistry: boolean;
  providerIds: string[];
  includeCatalogPrices: boolean;
}


export interface CatalogJobRequest {
  type: 'catalog_refresh';
  providerIds: string[];
  label?: string;
}

export interface SubmitOptions {
  idempotencyKey?: string;

  operationId?: string;
  watchId?: string;
  parentJobId?: string;

  origin?: JobOrigin;
}


export abstract class JobSubmitter {
  abstract submit(request: CreateJobRequestParsed | WatchJobRequest | CatalogJobRequest, options?: SubmitOptions): Job;
  abstract get(jobId: string): Job;
}


export abstract class JobLifecycle {
  abstract onFinished(listener: (job: Job) => void): () => void;
}


export abstract class JobResults {
  abstract list(
    jobId: string,
    filter: ResultFilterParsed,
    cursor?: string | null,
    limit?: number,
  ): { items: JobItem[]; nextCursor: string | null; total: number };

  abstract matchingIds(jobId: string, filter: ResultFilterParsed): string[];

  abstract byIds(itemIds: string[]): JobItem[];
}


export abstract class CoverageReader {
  abstract counts(): { tested: number; discovered: number; unsupported: number };
}

export interface SuffixProvider {
  providerId: string;
  name: string;
  kind: 'registrar' | 'directory';
  supportsSuffix: 'yes' | 'no' | 'unknown';
  purchaseUrl: string | null;
  purchaseKind: 'search' | 'dashboard' | 'website' | null;
  enabled: boolean;
  preferred: boolean;
}


export abstract class ProviderDirectory {
  abstract summary(): { id: string; name: string; readiness: ProviderReadiness }[];

  abstract forDomain(domain: string, suffix: string): SuffixProvider[];
  abstract exists(providerId: string): boolean;
}


export abstract class NameCheckCatalog {
  abstract services(): NameCheckService[];
}
