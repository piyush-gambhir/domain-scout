import { Inject, Injectable } from '@nestjs/common';
import { domainToUnicode } from 'node:url';
import type { CreateJobRequestParsed, JobOperation, JobType, NormalizedDomain } from '@domain-scout/contracts';
import { AppError } from '../core/errors.js';
import type { CatalogJobRequest, WatchJobRequest } from '../core/ports.js';
import { Database } from '../storage/database.js';
import { SettingsService } from '../system/settings.service.js';
import { JOBS_ENGINE_OPTIONS, type JobsEngineOptions } from './engine-options.js';
import type { JobInputSummary, StoredJobInput } from './job-store.js';
import { OptionalPorts } from './optional-ports.js';

export type SubmitRequest = CreateJobRequestParsed | WatchJobRequest | CatalogJobRequest;

export interface PlannedItem {
  subject: string;
  unicode: string;
  suffix: string | null;
  operation: JobOperation;
  /** Provider, service, check or marketplace id; '' when not applicable. */
  target: string;
}

export interface JobPlan {
  type: JobType;
  label: string | null;
  watchId: string | null;
  input: StoredJobInput;
  items: PlannedItem[];
}

interface DomainInfo {
  ascii: string;
  unicode: string;
  suffix: string;
}

const MAX_INVALID_DETAILS = 50;

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function summary(partial: Partial<JobInputSummary>): JobInputSummary {
  return { extensions: [], providerIds: [], services: [], checks: [], rows: 0, ...partial };
}

/** Turns a validated request into job items. Pure planning: no external queries, no writes. */
@Injectable()
export class JobPlanner {
  constructor(
    private readonly ports: OptionalPorts,
    private readonly db: Database,
    @Inject(JOBS_ENGINE_OPTIONS) private readonly options: JobsEngineOptions,
    private readonly settings: SettingsService,
  ) {}

  plan(request: SubmitRequest): JobPlan {
    const plan = this.build(request);
    if (plan.items.length === 0) throw AppError.invalid('The request has nothing to check');
    if (plan.items.length > this.options.maxItemsPerJob) {
      throw AppError.invalid(
        `The request expands to ${plan.items.length} checks; split it into jobs of at most ${this.options.maxItemsPerJob}`,
      );
    }
    return plan;
  }

  private build(request: SubmitRequest): JobPlan {
    const label = request.label ?? null;
    switch (request.type) {
      case 'registry_scan':
        return this.registryScan(request);
      case 'provider_check':
      case 'quote':
      case 'transfer': {
        const domains = this.domains(request.domains);
        const providerIds = this.providerIds(request.providerIds);
        const items = domains.flatMap((d) => providerIds.map((p) => this.domainItem(d, request.type, p)));
        return {
          type: request.type,
          label,
          watchId: null,
          input: { ...request, recheck: false, summary: summary({ providerIds, rows: domains.length }) },
          items,
        };
      }
      case 'aftermarket': {
        const domains = this.domains(request.domains);
        const sources = unique(request.sources);
        const items = domains.flatMap((d) => sources.map((s) => this.domainItem(d, 'aftermarket', s)));
        return {
          type: 'aftermarket',
          label,
          watchId: null,
          input: { ...request, recheck: false, summary: summary({ services: sources, rows: domains.length }) },
          items,
        };
      }
      case 'name_check': {
        const names = unique(request.names.map((n) => n.trim()).filter((n) => n.length > 0));
        const services = unique(request.services);
        const items = names.flatMap((name) =>
          services.map((service): PlannedItem => ({ subject: name, unicode: name, suffix: null, operation: 'name_check', target: service })),
        );
        return {
          type: 'name_check',
          label,
          watchId: null,
          input: { ...request, recheck: false, summary: summary({ services, rows: names.length }) },
          items,
        };
      }
      case 'diagnostics': {
        const domains = this.domains(request.domains);
        const checks = unique(request.checks);
        const items = domains.flatMap((d) => checks.map((c) => this.domainItem(d, 'diagnostic', c)));
        // Fixed at planning so recorded destinations, source budgets and a later resume all use the
        // resolver that was configured when the job was submitted.
        const resolver = request.resolver ?? this.settings.get().diagnostics.resolver;
        return {
          type: 'diagnostics',
          label,
          watchId: null,
          input: { ...request, resolver, recheck: false, summary: summary({ checks, rows: domains.length }) },
          items,
        };
      }
      case 'catalog_refresh': {
        const providerIds = this.providerIds(request.providerIds);
        const items = providerIds.map(
          (p): PlannedItem => ({ subject: p, unicode: p, suffix: null, operation: 'catalog', target: p }),
        );
        return {
          type: 'catalog_refresh',
          label,
          watchId: null,
          input: { ...request, recheck: false, summary: summary({ providerIds, rows: providerIds.length }) },
          items,
        };
      }
      case 'watch':
        return this.watch(request);
    }
  }

  private registryScan(request: Extract<CreateJobRequestParsed, { type: 'registry_scan' }>): JobPlan {
    const previewer = this.ports.previewer();
    if (!previewer) {
      throw new AppError('unavailable', 'Input normalization is not available, so registry scans cannot be planned', {
        retryable: true,
      });
    }
    const preview = previewer.preview(request.input);
    const normalized = new Map<string, NormalizedDomain>();
    for (const row of preview.rows) {
      if (row.status === 'valid' && row.domain && !normalized.has(row.domain.ascii)) normalized.set(row.domain.ascii, row.domain);
    }
    const items = unique(preview.domains).map((ascii): PlannedItem => {
      const domain = normalized.get(ascii);
      return {
        subject: ascii,
        unicode: domain?.unicode ?? safeUnicode(ascii),
        suffix: domain?.suffix ?? fallbackSuffix(ascii),
        operation: 'registry',
        target: '',
      };
    });
    if (items.length === 0) {
      throw AppError.invalid(
        `The input has no valid domains to check (${preview.counts.invalid} invalid, ${preview.counts.ambiguous} ambiguous, ${preview.counts.duplicate} duplicate)`,
      );
    }
    return {
      type: 'registry_scan',
      label: request.label ?? null,
      watchId: null,
      input: {
        ...request,
        recheck: request.recheck,
        summary: summary({ extensions: preview.extensions, rows: preview.counts.inputRows }),
      },
      items,
    };
  }

  private watch(request: WatchJobRequest): JobPlan {
    const exists = this.db.get<{ id: string }>('SELECT id FROM watches WHERE id = ?', [request.watchId]);
    if (!exists) throw AppError.notFound('Watch');
    const domains = this.domains(request.domains);
    const providerIds = this.providerIds(request.providerIds);
    const items: PlannedItem[] = [];
    for (const d of domains) {
      if (request.includeRegistry) items.push(this.domainItem(d, 'registry', ''));
      for (const p of providerIds) items.push(this.domainItem(d, 'quote', p));
    }
    // Catalog prices are suffix-level and send no names: one refresh per watched provider.
    if (request.includeCatalogPrices) {
      for (const p of providerIds) items.push({ subject: p, unicode: p, suffix: null, operation: 'catalog', target: p });
    }
    return {
      type: 'watch',
      label: request.label ?? null,
      watchId: request.watchId,
      input: { ...request, recheck: false, summary: summary({ providerIds, rows: domains.length }) },
      items,
    };
  }

  private domainItem(d: DomainInfo, operation: JobOperation, target: string): PlannedItem {
    return { subject: d.ascii, unicode: d.unicode, suffix: d.suffix, operation, target };
  }

  /** Normalizes explicit domains; any the registry rules reject fail the request with details. */
  private domains(domains: readonly string[]): DomainInfo[] {
    const previewer = this.ports.previewer();
    const out: DomainInfo[] = [];
    const seen = new Set<string>();
    const invalid: string[] = [];
    for (const raw of domains) {
      let info: DomainInfo | null;
      if (previewer) {
        const n = previewer.normalize(raw);
        info = n ? { ascii: n.ascii, unicode: n.unicode, suffix: n.suffix } : null;
      } else {
        info = { ascii: raw, unicode: safeUnicode(raw), suffix: fallbackSuffix(raw) };
      }
      if (!info) {
        invalid.push(raw);
        continue;
      }
      if (seen.has(info.ascii)) continue;
      seen.add(info.ascii);
      out.push(info);
    }
    if (invalid.length > 0) {
      throw AppError.invalid(
        `${invalid.length} domain(s) are not registrable domains`,
        invalid.slice(0, MAX_INVALID_DETAILS).map((d) => ({ path: 'domains', message: `${d} is not a registrable domain` })),
      );
    }
    return out;
  }

  private providerIds(ids: readonly string[]): string[] {
    const providerIds = unique(ids);
    const directory = this.ports.providers();
    if (directory) {
      const unknown = providerIds.filter((id) => !directory.exists(id));
      if (unknown.length > 0) {
        throw new AppError('invalid_request', `Unknown provider: ${unknown.join(', ')}`, {
          source: unknown[0] ?? null,
          details: unknown.map((id) => ({ path: 'providerIds', message: `Unknown provider ${id}` })),
        });
      }
    }
    return providerIds;
  }
}

function safeUnicode(ascii: string): string {
  return domainToUnicode(ascii) || ascii;
}

/** Only used when no InputPreviewer is registered: everything after the first label. */
function fallbackSuffix(ascii: string): string {
  const dot = ascii.indexOf('.');
  return dot >= 0 ? ascii.slice(dot + 1) : ascii;
}
