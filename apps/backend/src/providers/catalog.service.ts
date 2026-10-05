import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Reason } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { EventsService } from '../events/events.service.js';
import { Database, json } from '../storage/database.js';
import { EvidenceRepository } from '../storage/evidence.js';
import { SettingsService } from '../system/settings.service.js';
import { recomputeBestPrices } from '../pricing/best-prices.js';
import { ProviderError, type CatalogResult } from './adapters/types.js';
import { ProvidersService, describeFailure, missingCredentialsMessage } from './providers.service.js';
import { offerRecord } from './records.js';

/** Catalog downloads are large (Porkbun lists about 900 TLDs); they get a longer transport timeout. */
export const CATALOG_TIMEOUT_MS = 120_000;

export type CatalogOutcome =
  | 'updated'
  | 'unchanged'
  | 'failed'
  | 'rate_limited'
  | 'credentials_invalid'
  | 'credential_required'
  | 'unsupported';

export interface CatalogRefresh {
  outcome: CatalogOutcome;
  fetchId: string | null;
  suffixCount: number;
  error: { code: string; message: string; retryable: boolean } | null;
  retryAt: string | null;
}

/**
 * Fetches provider catalogs (no candidate names are sent) and records them: one catalog_fetches
 * row per attempt, the provider's suffix list, published offers and best prices, in one
 * transaction. A failed refresh adds only a failed fetch row, so earlier prices stay (and age into
 * stale) instead of disappearing or turning into zero.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
    private readonly evidence: EvidenceRepository,
    private readonly providers: ProvidersService,
  ) {}

  async refresh(providerId: string, signal?: AbortSignal): Promise<CatalogRefresh> {
    const manifest = this.providers.require(providerId);
    const capability = manifest.capabilities.catalog;
    const adapter = this.providers.adapters.get(providerId);
    if (capability.level === 'unsupported' || !adapter?.catalog) {
      return this.result('unsupported', { code: 'unsupported', message: capability.notes ?? `${manifest.name} has no catalog`, retryable: false });
    }
    const credentials = this.providers.resolveCredentials(manifest);
    if (capability.requiresCredentials && !credentials.configured) {
      return this.result('credential_required', { code: 'credential_required', message: missingCredentialsMessage(manifest), retryable: false });
    }
    // Full price lists can take longer than one check; the caller's signal still bounds the call.
    const ctx = this.providers.context(manifest, signal, credentials, CATALOG_TIMEOUT_MS);
    const fetchedAt = this.clock.iso();
    const source = capability.source ?? manifest.docsUrl;
    let catalog: CatalogResult;
    try {
      catalog = await adapter.catalog(ctx);
    } catch (error) {
      const message = ctx.http.scrub(describeFailure(manifest, error));
      const kind = error instanceof ProviderError ? error.kind : 'transient';
      const code = kind === 'auth' ? 'credentials_invalid' : kind === 'rate_limited' ? 'rate_limited' : `catalog_${kind}`;
      this.recordFailure(providerId, { code, message }, fetchedAt, source);
      if (kind === 'auth') this.providers.markCredentialsInvalid(providerId, message);
      const retryAt = error instanceof ProviderError ? (error.extras.retryAt ?? null) : null;
      const outcome: CatalogOutcome = kind === 'auth' ? 'credentials_invalid' : kind === 'rate_limited' ? 'rate_limited' : 'failed';
      return { ...this.result(outcome, { code, message, retryable: kind === 'transient' || kind === 'rate_limited' }), retryAt };
    }
    if (catalog.suffixes.length === 0) {
      // An empty list would wipe supported suffixes and current prices; treat it as a bad response.
      const message = `${manifest.name} returned a catalog without any extensions`;
      this.recordFailure(providerId, { code: 'catalog_empty', message }, fetchedAt, source);
      return this.result('failed', { code: 'catalog_empty', message, retryable: false });
    }
    return this.recordSuccess(providerId, catalog, fetchedAt);
  }

  private result(outcome: CatalogOutcome, error: CatalogRefresh['error']): CatalogRefresh {
    return { outcome, fetchId: null, suffixCount: 0, error, retryAt: null };
  }

  recordFailure(providerId: string, reason: Reason, fetchedAt: string, source: string) {
    this.db.run(
      'INSERT INTO catalog_fetches (id, provider_id, status, fetched_at, suffix_count, source, error_json) VALUES (?, ?, ?, ?, 0, ?, ?)',
      [randomUUID(), providerId, 'failed', fetchedAt, source, json.stringify(reason)],
    );
  }

  recordSuccess(providerId: string, catalog: CatalogResult, fetchedAt: string): CatalogRefresh {
    const staleAt = new Date(Date.parse(fetchedAt) + this.settings.get().freshness.catalogHours * 3_600_000).toISOString();
    const suffixes = [...new Set(catalog.suffixes)].sort();
    const fingerprint = catalogFingerprint(suffixes, catalog);
    const fetchId = randomUUID();
    let unchanged = false;
    this.db.transaction(() => {
      const previous = this.providers.latestOkFetch(providerId);
      if (previous) unchanged = this.fingerprintOf(previous.id, providerId) === fingerprint;
      this.db.run(
        'INSERT INTO catalog_fetches (id, provider_id, status, fetched_at, suffix_count, source, error_json) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        [fetchId, providerId, 'ok', fetchedAt, suffixes.length, catalog.source],
      );
      this.db.run('DELETE FROM provider_suffixes WHERE provider_id = ?', [providerId]);
      for (const suffix of suffixes) {
        this.db.run('INSERT INTO provider_suffixes (provider_id, suffix, source, observed_at) VALUES (?, ?, ?, ?)', [
          providerId,
          suffix,
          catalog.source,
          fetchedAt,
        ]);
      }
      // Each refresh appends observations, so history keeps every fetched price with its time.
      for (const entry of catalog.entries) {
        const { suffix, ...draft } = entry;
        const { write } = offerRecord({ providerId, domain: null, suffix, draft, observedAt: fetchedAt, staleAt, destination: null, catalogFetchId: fetchId });
        this.evidence.insertOffer(write);
      }
      recomputeBestPrices(this.db);
      this.events.emit('catalog.updated', {}, { providerId, suffixCount: suffixes.length, fetchedAt });
    });
    return { outcome: unchanged ? 'unchanged' : 'updated', fetchId, suffixCount: suffixes.length, error: null, retryAt: null };
  }

  /** Fingerprint of a stored fetch, matching catalogFingerprint for "unchanged" detection. */
  private fingerprintOf(fetchId: string, providerId: string): string {
    const suffixes = this.db
      .all<{ suffix: string }>('SELECT suffix FROM provider_suffixes WHERE provider_id = ? ORDER BY suffix', [providerId])
      .map((r) => r.suffix);
    const rows = this.db.all<{ suffix: string; currency: string; registration: string | null; renewal: string | null; transfer: string | null }>(
      'SELECT suffix, currency, registration, renewal, transfer FROM offers WHERE catalog_fetch_id = ?',
      [fetchId],
    );
    return hashRows(suffixes, rows);
  }
}

function catalogFingerprint(suffixes: string[], catalog: CatalogResult): string {
  return hashRows(
    suffixes,
    catalog.entries.map((e) => ({ suffix: e.suffix, currency: e.currency, registration: e.registration.amount, renewal: e.renewal.amount, transfer: e.transfer.amount })),
  );
}

function hashRows(
  suffixes: string[],
  rows: { suffix: string; currency: string; registration: string | null; renewal: string | null; transfer: string | null }[],
): string {
  const lines = rows.map((r) => [r.suffix, r.currency, r.registration, r.renewal, r.transfer].join('|')).sort();
  return createHash('sha256').update(suffixes.join(',')).update('\n').update(lines.join('\n')).digest('hex');
}
