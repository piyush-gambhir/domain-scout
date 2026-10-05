import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  CatalogState as CatalogStateSchema,
  CredentialState,
  CredentialTest as CredentialTestSchema,
  Provider,
  ProviderReadiness,
  PurchasePath,
  Reason,
} from '@domain-scout/contracts';
import type { z } from 'zod';
import { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { Database, json } from '../storage/database.js';
import { freshnessOf } from '../storage/evidence.js';
import { SettingsService } from '../system/settings.service.js';
import { recomputeBestPrices } from '../pricing/best-prices.js';
import { createAdapters } from './adapters/index.js';
import { ProviderHttp } from './adapters/http.js';
import { ProviderError, type AdapterContext, type ProviderAdapter } from './adapters/types.js';
import { CredentialStore, type ResolvedCredentials } from './credentials.js';
import { buildManifests } from './directory.js';
import { fillTemplate, hasAuthenticatedCapability, type ProviderManifest } from './manifest.js';
import { ProviderTransport } from './transport.js';

type CredentialTest = z.infer<typeof CredentialTestSchema>;
type CatalogState = z.infer<typeof CatalogStateSchema>;

export interface ProviderRow {
  id: string;
  enabled: number;
  preferred: number;
  last_tested_at: string | null;
  last_test_result: 'ok' | 'failed' | 'not_testable' | null;
  last_test_message: string | null;
  last_test_operation: string | null;
  credential_status: 'invalid' | null;
  credential_status_message: string | null;
  credential_status_at: string | null;
  updated_at: string;
}

interface FetchRow {
  id: string;
  status: 'ok' | 'failed';
  fetched_at: string;
  suffix_count: number;
  source: string;
  error_json: string | null;
}

export interface Destination {
  url: string;
  kind: 'search' | 'dashboard' | 'website';
}

/**
 * Provider manifests, preferences, readiness and credentials. The single place that turns a
 * provider id into a purchase destination, so a displayed price and its link always come from the
 * same provider and purchase path.
 */
@Injectable()
export class ProvidersService implements OnModuleInit {
  private readonly manifestList: ProviderManifest[];
  private readonly manifestById: Map<string, ProviderManifest>;
  readonly adapters: Map<string, ProviderAdapter>;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly credentials: CredentialStore,
    @Inject(ProviderTransport) private readonly transport: ProviderTransport,
  ) {
    this.manifestList = buildManifests();
    this.manifestById = new Map(this.manifestList.map((m) => [m.id, m]));
    this.adapters = createAdapters();
  }

  onModuleInit() {
    const now = this.clock.iso();
    this.db.transaction(() => {
      for (const m of this.manifestList) {
        this.db.run('INSERT OR IGNORE INTO providers (id, enabled, preferred, updated_at) VALUES (?, 1, 0, ?)', [m.id, now]);
      }
    });
  }

  manifests(): ProviderManifest[] {
    return this.manifestList;
  }

  manifest(id: string): ProviderManifest | undefined {
    return this.manifestById.get(id);
  }

  require(id: string): ProviderManifest {
    const manifest = this.manifestById.get(id);
    if (!manifest) throw AppError.notFound(`Provider ${id}`);
    return manifest;
  }

  row(id: string): ProviderRow {
    const row = this.db.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', [id]);
    if (row) return row;
    return {
      id,
      enabled: 1,
      preferred: 0,
      last_tested_at: null,
      last_test_result: null,
      last_test_message: null,
      last_test_operation: null,
      credential_status: null,
      credential_status_message: null,
      credential_status_at: null,
      updated_at: this.clock.iso(),
    };
  }

  isEnabled(id: string): boolean {
    return this.row(id).enabled === 1;
  }

  resolveCredentials(manifest: ProviderManifest): ResolvedCredentials {
    return this.credentials.resolve(manifest);
  }

  list(): Provider[] {
    return this.manifestList.map((m) => this.toProvider(m));
  }

  get(id: string): Provider {
    return this.toProvider(this.require(id));
  }

  patch(id: string, patch: { enabled?: boolean; preferred?: boolean }): Provider {
    this.require(id);
    this.db.transaction(() => {
      const row = this.row(id);
      this.db.run('UPDATE providers SET enabled = ?, preferred = ?, updated_at = ? WHERE id = ?', [
        patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
        patch.preferred === undefined ? row.preferred : patch.preferred ? 1 : 0,
        this.clock.iso(),
        id,
      ]);
      // Best prices consider enabled providers only, with preferred ones winning ties.
      recomputeBestPrices(this.db);
    });
    return this.get(id);
  }

  putCredentials(id: string, values: Record<string, string>, storage: 'session' | 'file'): Provider {
    const manifest = this.require(id);
    this.credentials.save(manifest, values, storage, this.clock.iso());
    this.resetCredentialState(id);
    return this.get(id);
  }

  deleteCredentials(id: string): Provider {
    const manifest = this.require(id);
    this.credentials.remove(manifest);
    this.resetCredentialState(id);
    return this.get(id);
  }

  private resetCredentialState(id: string) {
    this.db.run(
      `UPDATE providers SET credential_status = NULL, credential_status_message = NULL, credential_status_at = NULL,
         last_tested_at = NULL, last_test_result = NULL, last_test_message = NULL, last_test_operation = NULL, updated_at = ?
       WHERE id = ?`,
      [this.clock.iso(), id],
    );
  }

  /** Records an authentication failure seen by an operation or test; readiness becomes credentials_invalid. */
  markCredentialsInvalid(id: string, message: string) {
    const now = this.clock.iso();
    this.db.run('UPDATE providers SET credential_status = ?, credential_status_message = ?, credential_status_at = ?, updated_at = ? WHERE id = ?', [
      'invalid',
      message,
      now,
      now,
      id,
    ]);
  }

  clearCredentialFailure(id: string) {
    this.db.run('UPDATE providers SET credential_status = NULL, credential_status_message = NULL, credential_status_at = NULL WHERE id = ?', [id]);
  }

  /** Adapter context with the provider's credentials, the configured timeout and secret scrubbing. */
  context(manifest: ProviderManifest, signal?: AbortSignal, credentials?: ResolvedCredentials, minTimeoutMs = 0): AdapterContext {
    const resolved = credentials ?? this.credentials.resolve(manifest);
    const values = resolved.values ?? {};
    const http = new ProviderHttp(this.transport, {
      timeoutMs: Math.max(this.settings.get().retries.timeoutMs, minTimeoutMs),
      signal,
      now: () => this.clock.now(),
      secrets: Object.values(values),
    });
    return { credentials: values, http, now: this.clock.now() };
  }

  async testCredentials(id: string): Promise<CredentialTest> {
    const manifest = this.require(id);
    const testedAt = this.clock.iso();
    if (manifest.credentialFields.length === 0) {
      return this.storeTest(id, { result: 'not_testable', testedAt, operation: null, message: `${manifest.name} has no account integration; there is nothing to test.` });
    }
    const resolved = this.credentials.resolve(manifest);
    if (!resolved.configured) {
      throw new AppError('credential_required', missingCredentialsMessage(manifest), { source: `provider:${id}` });
    }
    const adapter = this.adapters.get(id);
    if (!adapter?.testCredentials) {
      return this.storeTest(id, {
        result: 'not_testable',
        testedAt,
        operation: null,
        message: `${manifest.name} documents no account operation that avoids sending a domain name. Credentials are validated by the first requested check or quote.`,
      });
    }
    const ctx = this.context(manifest, undefined, resolved);
    try {
      const outcome = await adapter.testCredentials(ctx);
      this.clearCredentialFailure(id);
      return this.storeTest(id, { result: 'ok', testedAt, operation: outcome.operation, message: outcome.message });
    } catch (error) {
      const message = ctx.http.scrub(describeFailure(manifest, error));
      if (error instanceof ProviderError && error.kind === 'auth') this.markCredentialsInvalid(id, message);
      return this.storeTest(id, { result: 'failed', testedAt, operation: adapter.testOperation, message });
    }
  }

  private storeTest(id: string, test: CredentialTest): CredentialTest {
    this.db.run(
      'UPDATE providers SET last_tested_at = ?, last_test_result = ?, last_test_message = ?, last_test_operation = ?, updated_at = ? WHERE id = ?',
      [test.testedAt, test.result, test.message, test.operation, test.testedAt, id],
    );
    return test;
  }

  /** Destination for a provider, domain and purchase path, built from that provider's own template. */
  destination(providerId: string, domain: string, path: PurchasePath): Destination | null {
    const manifest = this.manifestById.get(providerId);
    if (!manifest) return null;
    const link = path === 'new_registration' ? manifest.purchaseLink : manifest.links?.[path];
    return link ? { url: fillTemplate(link.template, domain), kind: link.kind } : null;
  }

  /** yes: listed by a catalog or registry directory; no: a loaded catalog omits it; unknown otherwise. */
  supportsSuffix(manifest: ProviderManifest, suffix: string): 'yes' | 'no' | 'unknown' {
    if (manifest.knownSuffixes?.suffixes.includes(suffix)) return 'yes';
    if (manifest.kind === 'directory') return 'no';
    if (!this.latestOkFetch(manifest.id)) return 'unknown';
    const hit = this.db.get('SELECT 1 AS x FROM provider_suffixes WHERE provider_id = ? AND suffix = ?', [manifest.id, suffix]);
    return hit ? 'yes' : 'no';
  }

  latestOkFetch(providerId: string): FetchRow | undefined {
    return this.db.get<FetchRow>(
      "SELECT * FROM catalog_fetches WHERE provider_id = ? AND status = 'ok' ORDER BY fetched_at DESC, rowid DESC LIMIT 1",
      [providerId],
    );
  }

  catalogState(manifest: ProviderManifest): CatalogState | null {
    if (manifest.capabilities.catalog.level === 'unsupported') return null;
    const ok = this.latestOkFetch(manifest.id);
    const latest = this.db.get<FetchRow>('SELECT * FROM catalog_fetches WHERE provider_id = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1', [manifest.id]);
    const lastError = latest && latest.status === 'failed' ? json.parse<Reason | null>(latest.error_json, null) : null;
    if (!ok) return { suffixCount: 0, fetchedAt: null, staleAt: null, freshness: null, source: latest?.source ?? null, lastError };
    const staleAt = new Date(Date.parse(ok.fetched_at) + this.settings.get().freshness.catalogHours * 3_600_000).toISOString();
    return {
      suffixCount: ok.suffix_count,
      fetchedAt: ok.fetched_at,
      staleAt,
      freshness: freshnessOf(staleAt, this.clock.now()),
      source: ok.source,
      lastError,
    };
  }

  private suffixList(manifest: ProviderManifest): string[] | null {
    const known = manifest.knownSuffixes?.suffixes ?? [];
    if (!this.latestOkFetch(manifest.id)) return known.length ? [...known] : null;
    const listed = this.db.all<{ suffix: string }>('SELECT suffix FROM provider_suffixes WHERE provider_id = ? ORDER BY suffix', [manifest.id]).map((r) => r.suffix);
    return [...new Set([...listed, ...known])].sort();
  }

  credentialState(manifest: ProviderManifest, row = this.row(manifest.id), resolved = this.credentials.resolve(manifest)): CredentialState {
    return {
      configured: resolved.configured,
      storage: resolved.storage,
      storageLocation: resolved.storageLocation,
      fields: resolved.fields,
      lastTestedAt: row.last_tested_at,
      lastTestResult: row.last_test_result,
      lastTestMessage: row.last_test_message,
    };
  }

  readiness(manifest: ProviderManifest, row = this.row(manifest.id), resolved = this.credentials.resolve(manifest)): ProviderReadiness {
    if (row.enabled !== 1) return 'disabled';
    if (!hasAuthenticatedCapability(manifest)) return 'keyless';
    if (!resolved.configured) return 'credentials_missing';
    if (row.credential_status === 'invalid') return 'credentials_invalid';
    return 'ready';
  }

  toProvider(manifest: ProviderManifest): Provider {
    const row = this.row(manifest.id);
    const resolved = this.credentials.resolve(manifest);
    return {
      id: manifest.id,
      name: manifest.name,
      kind: manifest.kind,
      website: manifest.website,
      setupUrl: manifest.setupUrl,
      suffixes: this.suffixList(manifest),
      enabled: row.enabled === 1,
      preferred: row.preferred === 1,
      capabilities: manifest.capabilities,
      credentialFields: manifest.credentialFields,
      credentials: this.credentialState(manifest, row, resolved),
      readiness: this.readiness(manifest, row, resolved),
      catalog: this.catalogState(manifest),
      purchaseLink: manifest.purchaseLink,
      apiHosts: disclosureHosts(manifest),
      accountRequirements: manifest.accountRequirements,
      rateLimits: manifest.rateLimits,
    };
  }
}

/** Hosts that receive candidate names: the API host when any name-level capability is implemented. */
export function disclosureHosts(manifest: ProviderManifest): string[] {
  const { exactCheck, quote, transfer, aftermarket } = manifest.capabilities;
  const discloses = [exactCheck, quote, transfer, aftermarket].some((c) => c.level !== 'unsupported');
  return discloses && manifest.apiHost ? [manifest.apiHost] : [];
}

export function missingCredentialsMessage(manifest: ProviderManifest): string {
  const required = manifest.credentialFields.filter((f) => f.required);
  return `${manifest.name} credentials are not configured. Add ${required.map((f) => f.label).join(' and ')} in Settings > Providers, with the CLI, or through ${required
    .map((f) => f.envVar)
    .join(' and ')}.`;
}

export function describeFailure(manifest: ProviderManifest, error: unknown): string {
  if (error instanceof ProviderError) {
    switch (error.kind) {
      case 'auth':
        return `${error.message}${manifest.setupUrl ? ` Manage keys at ${manifest.setupUrl}.` : ''}`;
      case 'rate_limited':
        return `${error.message}${error.extras.retryAt ? ` Retry after ${error.extras.retryAt}.` : ''}`;
      default:
        return error.message;
    }
  }
  return `${manifest.name} request failed: ${(error as Error)?.message ?? 'unknown error'}`;
}
