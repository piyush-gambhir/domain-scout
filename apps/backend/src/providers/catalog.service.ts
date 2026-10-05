import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import type { Reason } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { EventsService } from '../events/events.service.js';
import { Database, json } from '../storage/database.js';
import { EvidenceRepository, type OfferWrite } from '../storage/evidence.js';
import { SettingsService } from '../system/settings.service.js';
import { recomputeBestPrices } from '../pricing/best-prices.js';
import { scrubSecrets } from './adapters/http.js';
import { ProviderError, type CatalogResult } from './adapters/types.js';
import { ProvidersService, describeFailure, missingCredentialsMessage } from './providers.service.js';
import { offerRecord, scrubDraft } from './records.js';

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
  /** Offers written for this fetch (empty when nothing was recorded). */
  offerIds: string[];
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
  private readonly logger = new Logger('Catalog');

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
    return this.recordSuccess(providerId, catalog, fetchedAt, (text) => ctx.http.scrub(text));
  }

  private result(outcome: CatalogOutcome, error: CatalogRefresh['error']): CatalogRefresh {
    return { outcome, fetchId: null, offerIds: [], suffixCount: 0, error, retryAt: null };
  }

  recordFailure(providerId: string, reason: Reason, fetchedAt: string, source: string) {
    this.db.run(
      'INSERT INTO catalog_fetches (id, provider_id, status, fetched_at, suffix_count, source, error_json) VALUES (?, ?, ?, ?, 0, ?, ?)',
      [randomUUID(), providerId, 'failed', fetchedAt, source, json.stringify(reason)],
    );
  }

  /**
   * Records a fetched catalog. Provider text is scrubbed of secrets (configured values when `scrub`
   * comes from the adapter context, common credential shapes always) and every offer is validated
   * against the contract first. Suffixes are normalized (case, leading dot, IDN to A-labels); an
   * entry that still fails validation is skipped and counted, so one odd row cannot block a
   * provider's catalog. A catalog where most entries fail is recorded as a failed fetch and the
   * previous prices stay current.
   */
  recordSuccess(
    providerId: string,
    catalog: CatalogResult,
    fetchedAt: string,
    scrub: (text: string) => string = (text) => scrubSecrets(text),
  ): CatalogRefresh {
    const staleAt = new Date(Date.parse(fetchedAt) + this.settings.get().freshness.catalogHours * 3_600_000).toISOString();
    const fetchId = randomUUID();
    const source = scrub(catalog.source);
    const writes: OfferWrite[] = [];
    const accepted = new Set<string>();
    let skipped = 0;
    let firstProblem: string | null = null;
    for (const entry of catalog.entries) {
      const { suffix: rawSuffix, ...draft } = entry;
      const suffix = normalizeSuffix(rawSuffix);
      try {
        if (!suffix) throw new ProviderError('bad_response', `Unusable suffix in catalog entry`);
        const clean = scrubDraft(draft, scrub);
        writes.push(
          offerRecord({ providerId, domain: null, suffix, draft: clean, observedAt: fetchedAt, staleAt, destination: null, catalogFetchId: fetchId })
            .write,
        );
        accepted.add(suffix);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        skipped += 1;
        firstProblem ??= scrub(error.message);
      }
    }
    if (catalog.entries.length > 0 && skipped * 2 > catalog.entries.length) {
      const message = `${skipped} of ${catalog.entries.length} catalog entries were malformed: ${firstProblem ?? 'unknown problem'}`;
      this.recordFailure(providerId, { code: 'catalog_bad_response', message }, fetchedAt, source);
      return this.result('failed', { code: 'catalog_bad_response', message, retryable: false });
    }
    if (skipped > 0) {
      this.logger.warn(`${providerId} catalog: skipped ${skipped} malformed of ${catalog.entries.length} entries`);
    }
    const listed = catalog.suffixes.map(normalizeSuffix).filter((s): s is string => s !== null);
    const suffixes = [...new Set([...listed, ...accepted])].sort();
    const fingerprint = catalogFingerprint(suffixes, catalog);
    let unchanged = false;
    this.db.transaction(() => {
      const previous = this.providers.latestOkFetch(providerId);
      if (previous) unchanged = this.fingerprintOf(previous.id, providerId) === fingerprint;
      this.db.run(
        'INSERT INTO catalog_fetches (id, provider_id, status, fetched_at, suffix_count, source, error_json) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        [fetchId, providerId, 'ok', fetchedAt, suffixes.length, source],
      );
      this.db.run('DELETE FROM provider_suffixes WHERE provider_id = ?', [providerId]);
      for (const suffix of suffixes) {
        this.db.run('INSERT INTO provider_suffixes (provider_id, suffix, source, observed_at) VALUES (?, ?, ?, ?)', [
          providerId,
          suffix,
          source,
          fetchedAt,
        ]);
      }
      // Each refresh appends observations, so history keeps every fetched price with its time.
      for (const write of writes) this.evidence.insertOffer(write);
      recomputeBestPrices(this.db);
      this.events.emit('catalog.updated', {}, { providerId, suffixCount: suffixes.length, fetchedAt });
    });
    return {
      outcome: unchanged ? 'unchanged' : 'updated',
      fetchId,
      offerIds: writes.map((w) => w.id),
      suffixCount: suffixes.length,
      error: null,
      retryAt: null,
    };
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

/** Lower-case A-label suffix without a leading dot, or null when it cannot be a registration suffix. */
export function normalizeSuffix(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\.+/, '').replace(/\.+$/, '').toLowerCase();
  if (!trimmed) return null;
  const ascii = domainToASCII(trimmed);
  return ascii && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(ascii) ? ascii : null;
}
