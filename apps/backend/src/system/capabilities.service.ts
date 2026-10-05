import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  CONTRACT_VERSION,
  DiagnosticCheck,
  ExportCreate,
  type JobOperation,
  type JobType,
} from '@domain-scout/contracts';
import { CoverageReader, NameCheckCatalog, ProviderDirectory } from '../core/ports.js';
import { OperationRegistry } from '../jobs/operation-registry.js';

/** Operations a job type needs; the type is advertised once any of them has a registered handler. */
const JOB_TYPE_OPERATIONS: Record<JobType, JobOperation[]> = {
  registry_scan: ['registry'],
  provider_check: ['provider_check'],
  quote: ['quote'],
  aftermarket: ['aftermarket'],
  transfer: ['transfer'],
  name_check: ['name_check'],
  diagnostics: ['diagnostic'],
  catalog_refresh: ['catalog'],
  watch: ['registry', 'provider_check'],
};

type Token<T> = abstract new (...args: never[]) => T;

/**
 * Feature summary for agents and the UI. Ports owned by other modules are optional: when a module
 * does not provide one, its section falls back to zeros or empty lists instead of failing.
 */
@Injectable()
export class CapabilitiesService {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly operations: OperationRegistry,
    @Optional() private readonly coverage?: CoverageReader,
    @Optional() private readonly providers?: ProviderDirectory,
    @Optional() private readonly nameChecks?: NameCheckCatalog,
  ) {}

  get() {
    const registered = new Set(this.operations.operations());
    const coverage = this.port(CoverageReader, this.coverage)?.counts() ?? { tested: 0, discovered: 0, unsupported: 0 };
    return {
      contractVersion: CONTRACT_VERSION,
      registry: { ...coverage, protocols: ['rdap', 'whois'] },
      providers: this.port(ProviderDirectory, this.providers)?.summary() ?? [],
      jobTypes: (Object.keys(JOB_TYPE_OPERATIONS) as JobType[]).filter((type) =>
        JOB_TYPE_OPERATIONS[type].some((op) => registered.has(op)),
      ),
      nameCheckServices:
        this.port(NameCheckCatalog, this.nameChecks)
          ?.services()
          .filter((s) => s.supported)
          .map((s) => s.id) ?? [],
      diagnostics: registered.has('diagnostic') ? [...DiagnosticCheck.options] : [],
      exportFormats: [...ExportCreate.shape.format.options],
      mcp: false,
    };
  }

  /** Constructor injection only sees exported providers; fall back to a container-wide lookup. */
  private port<T>(token: Token<T>, injected: T | undefined): T | undefined {
    if (injected) return injected;
    try {
      return this.moduleRef.get(token as never, { strict: false }) as T;
    } catch {
      return undefined;
    }
  }
}
