import { z } from 'zod';
import { AsciiDomain, OkResponse, PageQuery, Uuid } from './common.js';
import { InputPreviewResponse, InputSource } from './inputs.js';
import {
  CoverageListResponse,
  CoverageQuery,
  CoverageSummaryResponse,
  SuffixCoverageResponse,
} from './registry.js';
import {
  CredentialsPut,
  CredentialTestResponse,
  ProviderListResponse,
  ProviderPreferencesPatch,
  ProviderResponse,
} from './providers.js';
import {
  ComparisonRequest,
  ComparisonResponse,
  OfferListResponse,
  PriceHistoryQuery,
  PriceHistoryResponse,
  SuffixPricesQuery,
  SuffixPricesResponse,
} from './pricing.js';
import {
  AftermarketJobBody,
  CreateJobRequest,
  DiagnosticsJobBody,
  JobItemListResponse,
  JobListQuery,
  JobListResponse,
  JobResponse,
  NameCheckJobBody,
  ProviderJobBody,
  RecheckRequest,
  ResultQuery,
  RetryRequest,
} from './jobs.js';
import { EventQuery } from './events.js';
import {
  AftermarketListResponse,
  AftermarketSource,
  NameCheckServiceListResponse,
  PortfolioComparisonResponse,
  PortfolioImport,
  PortfolioImportResponse,
  PortfolioListResponse,
  TransferOption,
} from './enrichment.js';
import {
  CollectionCreate,
  CollectionEntriesAdd,
  CollectionEntriesAddResponse,
  CollectionEntriesRemove,
  CollectionEntryListResponse,
  CollectionEntryPatch,
  CollectionListResponse,
  CollectionPatch,
  CollectionResponse,
  ExtensionPresetCreate,
  ExtensionPresetListResponse,
  ExtensionPresetResponse,
  GenerationPreviewResponse,
  GenerationRequest,
  GenerationThemeListResponse,
  SavedCriteriaCreate,
  SavedCriteriaListResponse,
  SavedCriteriaResponse,
} from './library.js';
import {
  NoticeListResponse,
  NoticeQuery,
  NoticesMarkRead,
  WatchCreate,
  WatchListResponse,
  WatchPatch,
  WatchResponse,
  WatchRunListResponse,
} from './monitoring.js';
import {
  ExportCreate,
  ExportListResponse,
  ExportResponse,
  SnapshotCreate,
  SnapshotListResponse,
  SnapshotPreviewResponse,
  SnapshotResponse,
} from './artifacts.js';
import {
  BootstrapCodeResponse,
  CapabilitiesResponse,
  DataDelete,
  DataDeleteResponse,
  DataInventoryResponse,
  DomainEvidenceResponse,
  HealthResponse,
  HistoryListResponse,
  HistoryQuery,
  RawDiagnosticResponse,
  ServiceStopResponse,
  SessionExchange,
  SessionInfoResponse,
  SessionStatusResponse,
  SettingsPatch,
  SettingsResponse,
} from './system.js';
import { envelope, page } from './common.js';

export const API_PREFIX = '/api/v1';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteDef {
  method: HttpMethod;
  /** Express-style path relative to API_PREFIX, e.g. `/jobs/:id`. */
  path: string;
  summary: string;
  tag: string;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  response: z.ZodType;
  status?: 200 | 201 | 202;
  /** Accepts an Idempotency-Key header. */
  idempotent?: boolean;
  /** Sends names to external services (registries, providers, enrichment destinations). */
  external?: boolean;
  /** `none`: no local auth (health and session exchange only). */
  auth?: 'none' | 'required';
  /** Non-JSON success bodies. */
  produces?: 'json' | 'sse' | 'file';
}

const IdParams = z.object({ id: Uuid });
const ProviderParams = z.object({ id: z.string().regex(/^[a-z0-9-]+$/) });
const DomainParams = z.object({ name: z.string().min(1).max(253) });
const SuffixParams = z.object({ suffix: z.string().min(1).max(253) });
const EntryParams = z.object({ id: Uuid, domain: z.string().min(1).max(253) });
const CriteriaParams = z.object({ id: Uuid });
const PresetParams = z.object({ id: z.string().min(1).max(100) });
const DownloadQuery = z.object({ format: z.enum(['html', 'json']).default('html') });
const CatalogQuery = z.object({
  suffix: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});
const DomainsQuery = z.object({ domains: z.string().meta({ description: 'Comma-separated ASCII domains' }) });

const TransferOptionListResponse = page(TransferOption, 'TransferOptionListResponse');
const AftermarketSourceListResponse = page(AftermarketSource, 'AftermarketSourceListResponse');
const SseStream = z.string().meta({ id: 'SseStream', description: 'text/event-stream of DomainEvent messages' });
const FileBody = z.string().meta({ id: 'FileBody', description: 'File contents' });
const AsciiDomainList = z.object({ domains: z.array(AsciiDomain) });
const AsciiDomainListResponse = envelope(AsciiDomainList, 'AsciiDomainListResponse');

export const routes = {
  // System
  getHealth: { method: 'get', path: '/health', summary: 'Backend identity and versions', tag: 'system', response: HealthResponse, auth: 'none' },
  getCapabilities: { method: 'get', path: '/capabilities', summary: 'Supported features, coverage counts and provider readiness', tag: 'system', response: CapabilitiesResponse },
  getSettings: { method: 'get', path: '/settings', summary: 'Current settings', tag: 'system', response: SettingsResponse },
  patchSettings: { method: 'patch', path: '/settings', summary: 'Update settings', tag: 'system', body: SettingsPatch, response: SettingsResponse },
  stopService: { method: 'post', path: '/service/stop', summary: 'Gracefully stop the backend', tag: 'system', response: ServiceStopResponse, status: 202 },
  createBootstrapCode: { method: 'post', path: '/auth/bootstrap-codes', summary: 'Single-use code for opening the browser UI (API token only)', tag: 'system', response: BootstrapCodeResponse, status: 201 },
  createSession: { method: 'post', path: '/auth/session', summary: 'Exchange a bootstrap code for a browser session', tag: 'system', body: SessionExchange, response: SessionInfoResponse, status: 201, auth: 'none' },
  getSession: { method: 'get', path: '/auth/session', summary: 'Current browser session', tag: 'system', response: SessionStatusResponse },

  // Input
  previewInput: { method: 'post', path: '/inputs/preview', summary: 'Parse, validate, expand and deduplicate input without external queries', tag: 'inputs', body: InputSource, response: InputPreviewResponse },

  // Jobs
  createJob: { method: 'post', path: '/jobs', summary: 'Submit a job', tag: 'jobs', body: CreateJobRequest, response: JobResponse, status: 201, idempotent: true, external: true },
  listJobs: { method: 'get', path: '/jobs', summary: 'List jobs', tag: 'jobs', query: JobListQuery, response: JobListResponse },
  getJob: { method: 'get', path: '/jobs/:id', summary: 'Job state and counters', tag: 'jobs', params: IdParams, response: JobResponse },
  listJobResults: { method: 'get', path: '/jobs/:id/results', summary: 'Filtered, sorted, paginated job items', tag: 'jobs', params: IdParams, query: ResultQuery, response: JobItemListResponse },
  cancelJob: { method: 'post', path: '/jobs/:id/cancel', summary: 'Cancel a job, keeping completed evidence', tag: 'jobs', params: IdParams, response: JobResponse },
  resumeJob: { method: 'post', path: '/jobs/:id/resume', summary: 'Resume unfinished items of an interrupted or cancelled job', tag: 'jobs', params: IdParams, response: JobResponse, external: true },
  retryJob: { method: 'post', path: '/jobs/:id/retry', summary: 'Retry selected or unresolved items as a new job', tag: 'jobs', params: IdParams, body: RetryRequest, response: JobResponse, status: 201, idempotent: true, external: true },
  deleteJob: { method: 'delete', path: '/jobs/:id', summary: 'Delete a finished job; shared evidence used elsewhere is kept', tag: 'jobs', params: IdParams, response: OkResponse },
  createRecheck: { method: 'post', path: '/rechecks', summary: 'Fresh registry checks for selected domains', tag: 'jobs', body: RecheckRequest, response: JobResponse, status: 201, idempotent: true, external: true },

  // Events
  streamEvents: { method: 'get', path: '/events', summary: 'Server-sent events with replay', tag: 'events', query: EventQuery, response: SseStream, produces: 'sse' },

  // Coverage
  listCoverage: { method: 'get', path: '/coverage', summary: 'Per-suffix routing provenance and support status', tag: 'coverage', query: CoverageQuery, response: CoverageListResponse },
  getCoverageSummary: { method: 'get', path: '/coverage/summary', summary: 'Coverage counts, bootstrap dates and limits', tag: 'coverage', response: CoverageSummaryResponse },
  refreshCoverage: { method: 'post', path: '/coverage/refresh', summary: 'Refresh IANA bootstrap metadata (no candidate names are sent)', tag: 'coverage', response: CoverageSummaryResponse },
  getSuffixCoverage: { method: 'get', path: '/coverage/:suffix', summary: 'Coverage for one suffix', tag: 'coverage', params: SuffixParams, response: SuffixCoverageResponse },

  // Providers
  listProviders: { method: 'get', path: '/providers', summary: 'Providers, capabilities and readiness', tag: 'providers', query: PageQuery, response: ProviderListResponse },
  getProvider: { method: 'get', path: '/providers/:id', summary: 'One provider', tag: 'providers', params: ProviderParams, response: ProviderResponse },
  patchProvider: { method: 'patch', path: '/providers/:id', summary: 'Enable, disable or prefer a provider', tag: 'providers', params: ProviderParams, body: ProviderPreferencesPatch, response: ProviderResponse },
  listProviderCatalog: { method: 'get', path: '/providers/:id/catalog', summary: 'Latest published suffix prices', tag: 'providers', params: ProviderParams, query: CatalogQuery, response: OfferListResponse },
  refreshProviderCatalog: { method: 'post', path: '/providers/:id/catalog/refresh', summary: 'Fetch the provider catalog (no candidate names)', tag: 'providers', params: ProviderParams, response: JobResponse, status: 201, idempotent: true },
  putProviderCredentials: { method: 'put', path: '/providers/:id/credentials', summary: 'Save credentials; values are never returned', tag: 'providers', params: ProviderParams, body: CredentialsPut, response: ProviderResponse },
  deleteProviderCredentials: { method: 'delete', path: '/providers/:id/credentials', summary: 'Disconnect: remove saved credentials', tag: 'providers', params: ProviderParams, response: ProviderResponse },
  testProviderCredentials: { method: 'post', path: '/providers/:id/credentials/test', summary: 'Test credentials with a non-candidate account operation', tag: 'providers', params: ProviderParams, response: CredentialTestResponse },

  // External operations
  createQuotes: { method: 'post', path: '/quotes', summary: 'Exact-name quotes from selected providers', tag: 'operations', body: ProviderJobBody, response: JobResponse, status: 201, idempotent: true, external: true },
  createProviderChecks: { method: 'post', path: '/provider-checks', summary: 'Exact-name availability confirmation from selected providers', tag: 'operations', body: ProviderJobBody, response: JobResponse, status: 201, idempotent: true, external: true },
  createTransfers: { method: 'post', path: '/transfers', summary: 'Read-only transfer price quotes', tag: 'operations', body: ProviderJobBody, response: JobResponse, status: 201, idempotent: true, external: true },
  createAftermarket: { method: 'post', path: '/aftermarket', summary: 'Aftermarket listing lookups', tag: 'operations', body: AftermarketJobBody, response: JobResponse, status: 201, idempotent: true, external: true },
  listAftermarketSources: { method: 'get', path: '/aftermarket/sources', summary: 'Supported marketplaces', tag: 'operations', response: AftermarketSourceListResponse },
  createNameChecks: { method: 'post', path: '/name-checks', summary: 'Selected social, GitHub and package-name checks', tag: 'operations', body: NameCheckJobBody, response: JobResponse, status: 201, idempotent: true, external: true },
  listNameCheckServices: { method: 'get', path: '/name-checks/services', summary: 'Supported and unsupported name-check services', tag: 'operations', response: NameCheckServiceListResponse },
  createDiagnostics: { method: 'post', path: '/diagnostics', summary: 'Selected DNS, DNSSEC, TLS and HTTP diagnostics', tag: 'operations', body: DiagnosticsJobBody, response: JobResponse, status: 201, idempotent: true, external: true },

  // Evidence and cost
  getDomainEvidence: { method: 'get', path: '/domains/:name/evidence', summary: 'All retained evidence for a domain', tag: 'evidence', params: DomainParams, response: DomainEvidenceResponse },
  listDomainOffers: { method: 'get', path: '/domains/:name/offers', summary: 'Catalog and quote offers matching a domain', tag: 'evidence', params: DomainParams, query: PageQuery, response: OfferListResponse },
  listDomainTransferOptions: { method: 'get', path: '/domains/:name/transfer-options', summary: 'Read-only transfer comparison from retained data', tag: 'evidence', params: DomainParams, query: PageQuery, response: TransferOptionListResponse },
  listDomainListings: { method: 'get', path: '/domains/:name/listings', summary: 'Retained aftermarket listing evidence', tag: 'evidence', params: DomainParams, query: PageQuery, response: AftermarketListResponse },
  getRawDiagnostic: { method: 'get', path: '/observations/:id/raw', summary: 'Sanitized raw source response, when retained', tag: 'evidence', params: IdParams, response: RawDiagnosticResponse },
  listSuffixPrices: { method: 'get', path: '/prices', summary: 'Published prices per provider for several suffixes (no names are sent)', tag: 'evidence', query: SuffixPricesQuery, response: SuffixPricesResponse },
  getPriceHistory: { method: 'get', path: '/price-history', summary: 'Comparable observed price series', tag: 'evidence', query: PriceHistoryQuery, response: PriceHistoryResponse },
  createComparison: { method: 'post', path: '/comparisons', summary: 'Ownership cost comparison from retained offers', tag: 'evidence', body: ComparisonRequest, response: ComparisonResponse },

  // Collections, criteria, presets
  listCollections: { method: 'get', path: '/collections', summary: 'Shortlists', tag: 'collections', query: PageQuery, response: CollectionListResponse },
  createCollection: { method: 'post', path: '/collections', summary: 'Create a shortlist', tag: 'collections', body: CollectionCreate, response: CollectionResponse, status: 201 },
  getCollection: { method: 'get', path: '/collections/:id', summary: 'One shortlist', tag: 'collections', params: IdParams, response: CollectionResponse },
  patchCollection: { method: 'patch', path: '/collections/:id', summary: 'Rename or edit notes', tag: 'collections', params: IdParams, body: CollectionPatch, response: CollectionResponse },
  deleteCollection: { method: 'delete', path: '/collections/:id', summary: 'Delete a shortlist (evidence is kept)', tag: 'collections', params: IdParams, response: OkResponse },
  listCollectionEntries: { method: 'get', path: '/collections/:id/entries', summary: 'Shortlist entries with latest evidence', tag: 'collections', params: IdParams, query: PageQuery, response: CollectionEntryListResponse },
  addCollectionEntries: { method: 'post', path: '/collections/:id/entries', summary: 'Add domains', tag: 'collections', params: IdParams, body: CollectionEntriesAdd, response: CollectionEntriesAddResponse },
  removeCollectionEntries: { method: 'post', path: '/collections/:id/entries/remove', summary: 'Remove domains', tag: 'collections', params: IdParams, body: CollectionEntriesRemove, response: AsciiDomainListResponse },
  patchCollectionEntry: { method: 'patch', path: '/collections/:id/entries/:domain', summary: 'Set entry notes', tag: 'collections', params: EntryParams, body: CollectionEntryPatch, response: OkResponse },
  listCriteria: { method: 'get', path: '/criteria', summary: 'Saved search criteria', tag: 'collections', query: PageQuery, response: SavedCriteriaListResponse },
  createCriteria: { method: 'post', path: '/criteria', summary: 'Save criteria', tag: 'collections', body: SavedCriteriaCreate, response: SavedCriteriaResponse, status: 201 },
  getCriteria: { method: 'get', path: '/criteria/:id', summary: 'One saved criteria (restoring runs no queries)', tag: 'collections', params: CriteriaParams, response: SavedCriteriaResponse },
  putCriteria: { method: 'put', path: '/criteria/:id', summary: 'Replace saved criteria', tag: 'collections', params: CriteriaParams, body: SavedCriteriaCreate, response: SavedCriteriaResponse },
  deleteCriteria: { method: 'delete', path: '/criteria/:id', summary: 'Delete saved criteria', tag: 'collections', params: CriteriaParams, response: OkResponse },
  listPresets: { method: 'get', path: '/presets', summary: 'Built-in and saved extension presets', tag: 'collections', query: PageQuery, response: ExtensionPresetListResponse },
  createPreset: { method: 'post', path: '/presets', summary: 'Save an extension preset', tag: 'collections', body: ExtensionPresetCreate, response: ExtensionPresetResponse, status: 201 },
  deletePreset: { method: 'delete', path: '/presets/:id', summary: 'Delete a saved extension preset', tag: 'collections', params: PresetParams, response: OkResponse },

  // Generation
  previewGeneration: { method: 'post', path: '/generation/preview', summary: 'Generate candidates locally', tag: 'generation', body: GenerationRequest, response: GenerationPreviewResponse },
  listGenerationThemes: { method: 'get', path: '/generation/themes', summary: 'Bundled local theme word lists', tag: 'generation', response: GenerationThemeListResponse },

  // Monitoring
  listWatches: { method: 'get', path: '/watches', summary: 'Watches', tag: 'monitoring', query: PageQuery, response: WatchListResponse },
  createWatch: { method: 'post', path: '/watches', summary: 'Create a watch', tag: 'monitoring', body: WatchCreate, response: WatchResponse, status: 201 },
  getWatch: { method: 'get', path: '/watches/:id', summary: 'One watch', tag: 'monitoring', params: IdParams, response: WatchResponse },
  patchWatch: { method: 'patch', path: '/watches/:id', summary: 'Edit a watch', tag: 'monitoring', params: IdParams, body: WatchPatch, response: WatchResponse },
  deleteWatch: { method: 'delete', path: '/watches/:id', summary: 'Remove a watch (retained evidence is kept)', tag: 'monitoring', params: IdParams, response: OkResponse },
  pauseWatch: { method: 'post', path: '/watches/:id/pause', summary: 'Pause a watch', tag: 'monitoring', params: IdParams, response: WatchResponse },
  resumeWatch: { method: 'post', path: '/watches/:id/resume', summary: 'Resume a watch', tag: 'monitoring', params: IdParams, response: WatchResponse },
  runWatch: { method: 'post', path: '/watches/:id/run', summary: 'Run a watch now', tag: 'monitoring', params: IdParams, response: JobResponse, status: 201, idempotent: true, external: true },
  listWatchRuns: { method: 'get', path: '/watches/:id/runs', summary: 'Scheduled, missed and completed runs', tag: 'monitoring', params: IdParams, query: PageQuery, response: WatchRunListResponse },
  listNotices: { method: 'get', path: '/notices', summary: 'Change notices', tag: 'monitoring', query: NoticeQuery, response: NoticeListResponse },
  markNoticesRead: { method: 'post', path: '/notices/read', summary: 'Mark notices read', tag: 'monitoring', body: NoticesMarkRead, response: OkResponse },

  // Portfolio
  listPortfolio: { method: 'get', path: '/portfolio', summary: 'Imported portfolio entries', tag: 'portfolio', query: PageQuery, response: PortfolioListResponse },
  importPortfolio: { method: 'post', path: '/portfolio/import', summary: 'Import owned domains with user-supplied renewal facts', tag: 'portfolio', body: PortfolioImport, response: PortfolioImportResponse },
  deletePortfolioEntry: { method: 'delete', path: '/portfolio/:id', summary: 'Remove a portfolio entry', tag: 'portfolio', params: IdParams, response: OkResponse },
  comparePortfolio: { method: 'get', path: '/portfolio/comparison', summary: 'Compare renewal and transfer costs from retained data', tag: 'portfolio', query: PageQuery, response: PortfolioComparisonResponse },

  // History and data
  listHistory: { method: 'get', path: '/history', summary: 'Past jobs with restorable inputs', tag: 'history', query: HistoryQuery, response: HistoryListResponse },
  getDataInventory: { method: 'get', path: '/data', summary: 'Local data location and record counts', tag: 'history', response: DataInventoryResponse },
  deleteData: { method: 'post', path: '/data/delete', summary: 'Scoped deletion of local data', tag: 'history', body: DataDelete, response: DataDeleteResponse },

  // Artifacts
  createExport: { method: 'post', path: '/exports', summary: 'Create a TXT, CSV or JSON export with an explicit scope', tag: 'artifacts', body: ExportCreate, response: ExportResponse, status: 201 },
  listExports: { method: 'get', path: '/exports', summary: 'Exports', tag: 'artifacts', query: PageQuery, response: ExportListResponse },
  getExport: { method: 'get', path: '/exports/:id', summary: 'Export metadata', tag: 'artifacts', params: IdParams, response: ExportResponse },
  downloadExport: { method: 'get', path: '/exports/:id/download', summary: 'Export file', tag: 'artifacts', params: IdParams, response: FileBody, produces: 'file' },
  deleteExport: { method: 'delete', path: '/exports/:id', summary: 'Delete an export file', tag: 'artifacts', params: IdParams, response: OkResponse },
  previewSnapshot: { method: 'post', path: '/snapshots/preview', summary: 'Inspect what a snapshot would contain', tag: 'artifacts', body: SnapshotCreate, response: SnapshotPreviewResponse },
  createSnapshot: { method: 'post', path: '/snapshots', summary: 'Create a self-contained local snapshot', tag: 'artifacts', body: SnapshotCreate, response: SnapshotResponse, status: 201 },
  listSnapshots: { method: 'get', path: '/snapshots', summary: 'Snapshots', tag: 'artifacts', query: PageQuery, response: SnapshotListResponse },
  getSnapshot: { method: 'get', path: '/snapshots/:id', summary: 'Snapshot metadata', tag: 'artifacts', params: IdParams, response: SnapshotResponse },
  downloadSnapshot: { method: 'get', path: '/snapshots/:id/download', summary: 'Snapshot HTML or JSON', tag: 'artifacts', params: IdParams, query: DownloadQuery, response: FileBody, produces: 'file' },
  deleteSnapshot: { method: 'delete', path: '/snapshots/:id', summary: 'Delete a snapshot', tag: 'artifacts', params: IdParams, response: OkResponse },
} as const satisfies Record<string, RouteDef>;

export type Routes = typeof routes;
export type OperationId = keyof Routes;

type Infer<T> = T extends z.ZodType ? z.output<T> : never;
type InferIn<T> = T extends z.ZodType ? z.input<T> : never;

/** Request arguments accepted by the typed client for an operation. */
export type OperationArgs<Op extends OperationId> = (Routes[Op] extends { params: infer P } ? { params: InferIn<P> } : {}) &
  (Routes[Op] extends { query: infer Q } ? { query?: InferIn<Q> } : {}) &
  (Routes[Op] extends { body: infer B } ? { body: InferIn<B> } : {}) & {
    idempotencyKey?: string;
    signal?: AbortSignal;
  };

/** Parsed success response of an operation. */
export type OperationResponse<Op extends OperationId> = Infer<Routes[Op]['response']>;

/** Fill `:param` placeholders in a route path. */
export function buildPath(path: string, params?: Record<string, string | number>): string {
  return path.replace(/:([A-Za-z]+)/g, (_, key: string) => {
    const value = params?.[key];
    if (value === undefined) throw new Error(`Missing path parameter ${key}`);
    return encodeURIComponent(String(value));
  });
}
