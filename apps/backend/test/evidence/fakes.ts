import { randomUUID } from 'node:crypto';
import type {
  ExtensionPreset,
  InputPreview,
  InputSourceParsed,
  Job,
  JobItem,
  NormalizedDomain,
  ResultFilterParsed,
} from '@domain-scout/contracts';
import {
  InputPreviewer,
  JobLifecycle,
  JobResults,
  JobSubmitter,
  ProviderDirectory,
  type CatalogJobRequest,
  type SubmitOptions,
  type SuffixProvider,
  type WatchJobRequest,
} from '../../src/core/ports.js';
import { fallbackNormalize } from '../../src/evidence/evidence-reader.service.js';
import type { EvidenceRepository } from '../../src/storage/evidence.js';
import { Clock } from '../../src/core/clock.js';
import { Database } from '../../src/storage/database.js';

/*
 * Fakes for ports owned by other modules, plus builders for contract-shaped evidence rows.
 * Fixture provenance: hand-written reconstructions of the contract shapes in packages/contracts,
 * not captured source responses.
 */

const MULTI_LABEL = ['co.uk', 'com.au', 'org.uk'];

/** Registry-module stand-in: lower-cases, converts IDN and knows a few multi-label suffixes. */
export class FakePreviewer extends InputPreviewer {
  preview(_source: InputSourceParsed): InputPreview {
    throw new Error('not used');
  }
  presets(): ExtensionPreset[] {
    return [
      { id: 'popular', name: 'Popular', extensions: ['com', 'net', 'org', 'io'], builtIn: true, createdAt: null },
      { id: 'europe', name: 'Europe', extensions: ['eu', 'de', 'si', 'co.uk'], builtIn: true, createdAt: null },
    ];
  }
  normalize(domain: string): NormalizedDomain | null {
    const base = fallbackNormalize(domain);
    if (!base) return null;
    const multi = MULTI_LABEL.find((s) => base.ascii.endsWith(`.${s}`));
    if (!multi) return base.ascii.split('.').length === 2 ? base : null;
    const label = base.ascii.slice(0, -(multi.length + 1));
    if (label.includes('.')) return null;
    return { ...base, label, suffix: multi };
  }
}

type Request = Parameters<JobSubmitter['submit']>[0];

export class FakeJobs extends JobSubmitter {
  readonly submitted: { request: Request | WatchJobRequest | CatalogJobRequest; options?: SubmitOptions; job: Job }[] = [];
  readonly jobs = new Map<string, Job>();
  private readonly byKey = new Map<string, Job>();
  /** Runs synchronously inside submit(), e.g. to simulate a job that finishes before submit returns. */
  afterSubmit: ((job: Job) => void) | null = null;

  /** With a database, submitted jobs also get a jobs row so foreign keys hold, as with the real engine. */
  constructor(
    private readonly clock: Clock,
    private readonly db?: Database,
  ) {
    super();
  }

  submit(request: Request | WatchJobRequest | CatalogJobRequest, options?: SubmitOptions): Job {
    if (options?.idempotencyKey) {
      const existing = this.byKey.get(options.idempotencyKey);
      if (existing) return existing;
    }
    const job = makeJob({
      type: request.type,
      watchId: options?.watchId ?? null,
      createdAt: this.clock.iso(),
      startedAt: this.clock.iso(),
    });
    this.jobs.set(job.id, job);
    this.db?.run(
      'INSERT INTO jobs (id, type, state, label, input_json, watch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [job.id, job.type, job.state, null, JSON.stringify(request), job.watchId, job.createdAt, job.updatedAt],
    );
    if (options?.idempotencyKey) this.byKey.set(options.idempotencyKey, job);
    this.submitted.push({ request, options, job });
    this.afterSubmit?.(job);
    return this.jobs.get(job.id)!;
  }

  get(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('job not found');
    return job;
  }

  /**
   * Record evidence as written by this job, the way the engine does: one finished item per row,
   * registry ids in registry_observation_id, others in evidence_json.
   */
  attach(jobId: string, evidence: CreatedEvidence[], options: { reusedRegistry?: boolean } = {}) {
    if (!this.db) throw new Error('FakeJobs.attach needs a database');
    const seq = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM job_items WHERE job_id = ?', [jobId])!.n;
    evidence.forEach((e, index) => {
      const refs =
        e.table === 'offer' ? { offers: [e.id] } : e.kind === 'registry' ? (options.reusedRegistry ? { reusedRegistry: true } : {}) : { observations: [e.id] };
      this.db!.run(
        `INSERT INTO job_items (id, job_id, seq, subject, unicode, suffix, operation, target, state, outcome, resolved,
           registry_observation_id, evidence_json, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, '', 'finished', 'x', 1, ?, ?, ?)`,
        [randomUUID(), jobId, seq + index, e.id, e.id, e.kind === 'registry' ? 'registry' : 'quote',
          e.kind === 'registry' ? e.id : null, JSON.stringify(refs), this.clock.iso()],
      );
    });
  }

  /** Mark a job terminal and return the updated object. */
  finish(jobId: string, state: Job['state'], finishedAt: string, counters: Partial<Job['counters']> = {}): Job {
    const job = { ...this.get(jobId), state, finishedAt, updatedAt: finishedAt, counters: { ...this.get(jobId).counters, ...counters } };
    this.jobs.set(jobId, job);
    return job;
  }
}

export class FakeLifecycle extends JobLifecycle {
  private listeners: ((job: Job) => void)[] = [];
  onFinished(listener: (job: Job) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  emit(job: Job) {
    for (const listener of this.listeners) listener(job);
  }
}

export class FakeResults extends JobResults {
  /** jobId -> items in result order. */
  readonly items = new Map<string, JobItem[]>();
  list(jobId: string, filter: ResultFilterParsed) {
    const items = this.items.get(jobId)!.filter((item) => matches(item, filter));
    return { items, nextCursor: null, total: items.length };
  }
  matchingIds(jobId: string, filter: ResultFilterParsed): string[] {
    const items = this.items.get(jobId);
    if (!items) throw new Error('job not found');
    return items.filter((item) => matches(item, filter)).map((item) => item.id);
  }
  byIds(itemIds: string[]): JobItem[] {
    const all = new Map([...this.items.values()].flat().map((item) => [item.id, item]));
    return itemIds.map((id) => all.get(id)).filter((item): item is JobItem => !!item);
  }
}

function matches(item: JobItem, filter: ResultFilterParsed): boolean {
  if (filter.outcomes?.length && !filter.outcomes.includes(item.outcome ?? '')) return false;
  if (filter.suffixes?.length && !filter.suffixes.includes(item.suffix ?? '')) return false;
  if (filter.q && !item.subject.includes(filter.q)) return false;
  return true;
}

export class FakeDirectory extends ProviderDirectory {
  summary() {
    return [{ id: 'porkbun', name: 'Porkbun', readiness: 'keyless' as const }];
  }
  forDomain(domain: string, suffix: string): SuffixProvider[] {
    return [
      {
        providerId: 'porkbun',
        name: 'Porkbun',
        supportsSuffix: suffix === 'com' ? 'yes' : 'unknown',
        purchaseUrl: `https://porkbun.com/checkout/search?q=${domain}`,
        purchaseKind: 'search',
        enabled: true,
        preferred: false,
      },
    ];
  }
  exists(providerId: string) {
    return ['porkbun', 'namecheap', 'dynadot'].includes(providerId);
  }
}

export function makeJob(overrides: Partial<Job> = {}): Job {
  const now = overrides.createdAt ?? '2026-10-05T12:00:00.000Z';
  return {
    id: randomUUID(),
    type: 'registry_scan',
    state: 'running',
    label: null,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
    counters: { total: 0, pending: 0, running: 0, finished: 0, interrupted: 0, resolved: 0, unresolved: 0, outcomes: {} },
    destinations: [],
    input: { extensions: [], providerIds: [], services: [], checks: [], rows: 0, text: null, format: null, csvColumn: null },
    watchId: null,
    parentJobId: null,
    origin: 'api',
    nextRetryAt: null,
    ...overrides,
  };
}

const MINUTE = 60_000;
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

export interface CreatedEvidence {
  table: 'observation' | 'offer';
  kind: string;
  id: string;
}

/** Writes contract-shaped evidence through the shared repository. */
export class EvidenceFixtures {
  /** Every row written, in order, so tests can attribute rows to a fake job. */
  readonly created: CreatedEvidence[] = [];

  constructor(private readonly repo: EvidenceRepository) {}

  registry(domain: string, outcome: string, at: string, extra: { registration?: unknown; reason?: string; raw?: string; id?: string } = {}) {
    const id = extra.id ?? randomUUID();
    const suffix = domain.slice(domain.indexOf('.') + 1);
    const payload = {
      id,
      domain,
      unicode: domain,
      suffix,
      source: { registryId: 'test-registry', protocol: 'rdap', destination: 'https://rdap.test/', routing: 'iana_bootstrap' },
      outcome,
      eligibility: { status: 'unknown', source: null, scope: null },
      reason: { code: outcome, message: extra.reason ?? `Registry said ${outcome}` },
      checkedAt: at,
      staleAt: plus(at, 15 * MINUTE),
      httpStatus: outcome === 'registered' ? 200 : outcome === 'no_record' ? 404 : 429,
      retryAt: null,
      matchedName: outcome === 'registered' ? domain : null,
      parserVersion: 'test-1',
      registration: extra.registration ?? null,
      hasRawDiagnostics: !!extra.raw,
    };
    this.repo.insertObservation({
      id,
      kind: 'registry',
      subject: domain,
      suffix,
      sourceId: 'registry:test-registry',
      destination: 'https://rdap.test/',
      outcome,
      observedAt: at,
      staleAt: payload.staleAt,
      payload,
      raw: extra.raw ? { contentType: 'application/json', body: extra.raw, truncated: false } : null,
    });
    this.created.push({ table: 'observation', kind: 'registry', id });
    return id;
  }

  confirmation(domain: string, providerId: string, status: string, at: string) {
    const id = randomUUID();
    const payload = {
      id,
      providerId,
      domain,
      status,
      premium: null,
      checkedAt: at,
      staleAt: plus(at, 15 * MINUTE),
      destination: `api.${providerId}.test`,
      reason: { code: status, message: `Provider said ${status}` },
    };
    this.repo.insertObservation({
      id,
      kind: 'confirmation',
      subject: domain,
      suffix: domain.slice(domain.indexOf('.') + 1),
      sourceId: `provider:${providerId}`,
      destination: payload.destination,
      outcome: status,
      observedAt: at,
      staleAt: payload.staleAt,
      payload,
    });
    this.created.push({ table: 'observation', kind: 'confirmation', id });
    return id;
  }

  offer(o: {
    providerId: string;
    domain: string | null;
    suffix: string;
    registration: string | null;
    renewal?: string | null;
    at: string;
    kind?: 'published' | 'estimated' | 'exact_quote';
    currency?: string;
    termYears?: number;
    promotional?: boolean;
    promotion?: { description: string; requiresTermYears: number | null; expiresAt: string | null; restrictions: string | null } | null;
    renewalYears?: number;
    purchasePath?: string;
    sourceUrl?: string | null;
  }) {
    const id = randomUUID();
    const kind = o.kind ?? (o.domain ? 'exact_quote' : 'published');
    const staleAt = plus(o.at, kind === 'published' ? 24 * 60 * MINUTE : 15 * MINUTE);
    const payload = {
      id,
      providerId: o.providerId,
      domain: o.domain,
      suffix: o.suffix,
      purchasePath: o.purchasePath ?? 'new_registration',
      kind,
      currency: o.currency ?? 'USD',
      region: null,
      registration: { amount: o.registration, years: o.termYears ?? 1 },
      minYears: null,
      renewal: { amount: o.renewal ?? null, years: o.renewalYears ?? 1 },
      transfer: { amount: null, includesYears: null },
      fees: { icann: null, other: [], tax: 'unknown' },
      premium: { status: 'unknown', registration: null, renewal: null },
      promotion: o.promotion ? { ...o.promotion, eligibilityVerified: false } : null,
      observedAt: o.at,
      publishedAt: null,
      quoteExpiresAt: null,
      staleAt,
      source: { label: `${o.providerId} ${kind}`, url: o.sourceUrl ?? null },
      destination: null,
    };
    this.repo.insertOffer({
      id,
      providerId: o.providerId,
      domain: o.domain,
      suffix: o.suffix,
      purchasePath: payload.purchasePath,
      kind,
      currency: payload.currency,
      region: null,
      termYears: o.termYears ?? 1,
      promotional: o.promotional ?? false,
      registration: o.registration,
      renewal: o.renewal ?? null,
      transfer: null,
      observedAt: o.at,
      staleAt,
      quoteExpiresAt: null,
      catalogFetchId: null,
      payload,
    });
    this.created.push({ table: 'offer', kind, id });
    return id;
  }

  observation(kind: 'name_check' | 'diagnostic' | 'listing', subject: string, outcome: string, at: string, payload: Record<string, unknown>) {
    const id = randomUUID();
    this.repo.insertObservation({
      id,
      kind,
      subject,
      suffix: null,
      sourceId: 'test',
      destination: 'test',
      outcome,
      observedAt: at,
      staleAt: plus(at, 15 * MINUTE),
      payload: { id, ...payload, checkedAt: at, staleAt: plus(at, 15 * MINUTE) },
    });
    this.created.push({ table: 'observation', kind, id });
    return id;
  }
}

/** Provider for JobSubmitter backed by FakeJobs; fetch the instance with app.get(JobSubmitter). */
export const fakeJobsProvider = {
  provide: JobSubmitter,
  inject: [Clock, Database],
  useFactory: (clock: Clock, db: Database) => new FakeJobs(clock, db),
};
