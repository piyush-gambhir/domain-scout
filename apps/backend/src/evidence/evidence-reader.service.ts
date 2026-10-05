import { Injectable, Optional } from '@nestjs/common';
import { domainToASCII, domainToUnicode } from 'node:url';
import type {
  AftermarketListing,
  Diagnostic,
  NameCheck,
  NormalizedDomain,
  Offer,
  ProviderConfirmation,
  RegistryObservation,
} from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { InputPreviewer } from '../core/ports.js';
import { Database } from '../storage/database.js';
import { hydrateObservation, hydrateOffer, type ObservationRow, type OfferRow } from '../storage/evidence.js';

const ASCII_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Latest evidence for one domain, as shown on shortlist entries and in exports. */
export interface LatestEvidence {
  registry: RegistryObservation | null;
  confirmations: ProviderConfirmation[];
  offers: Offer[];
}

/**
 * Read side of the shared evidence store. Every evidence kind stays separate; nothing here merges
 * registry outcomes with provider confirmations, offers, name checks or diagnostics.
 */
@Injectable()
export class EvidenceReader {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    @Optional() private readonly previewer?: InputPreviewer,
  ) {}

  /**
   * Normalize a complete domain through the registry module. Without that module, fall back to a
   * syntactic parse that treats everything after the first label as the suffix.
   */
  normalize(input: string): NormalizedDomain | null {
    if (this.previewer) {
      try {
        const normalized = this.previewer.normalize(input);
        if (normalized) return normalized;
      } catch {
        // Fall through to the syntactic parse.
      }
      return null;
    }
    return fallbackNormalize(input);
  }

  registryHistory(domain: string, limit = 50): RegistryObservation[] {
    return this.db
      .all<ObservationRow>(
        `SELECT * FROM observations WHERE kind = 'registry' AND subject = ? ORDER BY observed_at DESC, id DESC LIMIT ?`,
        [domain, limit],
      )
      .map((row) => this.registry(row));
  }

  latestRegistry(domain: string): RegistryObservation | null {
    return this.registryHistory(domain, 1)[0] ?? null;
  }

  registry(row: ObservationRow): RegistryObservation {
    return hydrateObservation<RegistryObservation>(row, this.clock.now(), { reused: false });
  }

  confirmation(row: ObservationRow): ProviderConfirmation {
    return hydrateObservation<ProviderConfirmation>(row, this.clock.now());
  }

  /** Every confirmation for the domain, newest first. */
  confirmations(domain: string, limit = 200): ProviderConfirmation[] {
    return this.db
      .all<ObservationRow>(
        `SELECT * FROM observations WHERE kind = 'confirmation' AND subject = ? ORDER BY observed_at DESC, id DESC LIMIT ?`,
        [domain, limit],
      )
      .map((row) => this.confirmation(row));
  }

  /** Newest confirmation per provider, chosen in SQL so long histories never hide a provider. */
  latestConfirmations(domain: string): ProviderConfirmation[] {
    return this.db
      .all<ObservationRow & { rn: number }>(
        `SELECT * FROM (
           SELECT o.*, ROW_NUMBER() OVER (
             PARTITION BY json_extract(payload_json, '$.providerId') ORDER BY observed_at DESC, id DESC) AS rn
           FROM observations o WHERE kind = 'confirmation' AND subject = ?
         ) WHERE rn = 1 ORDER BY observed_at DESC, id DESC`,
        [domain],
      )
      .map((row) => this.confirmation(row));
  }

  /**
   * Newest offer per provider, purchase path, kind, currency, region, term and promotion, for the
   * exact domain and for its suffix catalog. Different scopes stay separate rows.
   */
  latestOffers(domain: string, suffix: string): Offer[] {
    const now = this.clock.now();
    return this.db
      .all<OfferRow & { rn: number }>(
        `SELECT * FROM (
           SELECT o.*, ROW_NUMBER() OVER (
             PARTITION BY provider_id, purchase_path, kind, currency, IFNULL(region, ''), IFNULL(domain, ''), term_years, promotional
             ORDER BY observed_at DESC, id DESC) AS rn
           FROM offers o
           WHERE domain = ? OR (domain IS NULL AND suffix = ?)
         ) WHERE rn = 1
         ORDER BY provider_id, purchase_path, observed_at DESC`,
        [domain, suffix],
      )
      .map((row) => hydrateOffer<Offer>(row, now));
  }

  latest(domain: string, suffix: string): LatestEvidence {
    return {
      registry: this.latestRegistry(domain),
      confirmations: this.latestConfirmations(domain),
      offers: this.latestOffers(domain, suffix),
    };
  }

  /**
   * Name checks recorded for a label. Name-check subjects keep the case they were submitted with,
   * so match case-insensitively, on the A-label and on its Unicode form.
   */
  nameChecks(names: string[], limit = 200): NameCheck[] {
    const wanted = [...new Set(names.map((n) => n.toLowerCase()).filter(Boolean))];
    if (!wanted.length) return [];
    return this.db
      .all<ObservationRow>(
        `SELECT * FROM observations WHERE kind = 'name_check' AND lower(subject) IN (${wanted.map(() => '?').join(',')})
         ORDER BY observed_at DESC, id DESC LIMIT ?`,
        [...wanted, limit],
      )
      .map((row) => hydrateObservation<NameCheck>(row, this.clock.now()));
  }

  diagnostics(domain: string, limit = 200): Diagnostic[] {
    return this.db
      .all<ObservationRow>(
        `SELECT * FROM observations WHERE kind = 'diagnostic' AND subject = ? ORDER BY observed_at DESC, id DESC LIMIT ?`,
        [domain, limit],
      )
      .map((row) => hydrateObservation<Diagnostic>(row, this.clock.now()));
  }

  listings(domain: string, limit = 200): AftermarketListing[] {
    const now = this.clock.now();
    return this.db
      .all<ObservationRow>(
        `SELECT * FROM observations WHERE kind = 'listing' AND subject = ? ORDER BY observed_at DESC, id DESC LIMIT ?`,
        [domain, limit],
      )
      .map((row) => hydrateObservation<AftermarketListing>(row, now));
  }

  /** Collections containing the domain, with the entry's notes. */
  collectionsFor(domain: string): { id: string; name: string; notes: string | null }[] {
    return this.db.all<{ id: string; name: string; notes: string | null }>(
      `SELECT c.id, c.name, e.notes FROM collection_entries e JOIN collections c ON c.id = e.collection_id
       WHERE e.domain = ? ORDER BY c.name, c.id`,
      [domain],
    );
  }

  /** Every domain with registry, confirmation or exact-name offer evidence, in first-observed order. */
  observedDomains(): string[] {
    return this.db
      .all<{ subject: string }>(
        `SELECT subject, MIN(first_at) AS first_at FROM (
           SELECT subject, MIN(observed_at) AS first_at FROM observations WHERE kind IN ('registry', 'confirmation') GROUP BY subject
           UNION ALL
           SELECT domain AS subject, MIN(observed_at) AS first_at FROM offers WHERE domain IS NOT NULL GROUP BY domain
         ) GROUP BY subject ORDER BY first_at, subject`,
      )
      .map((row) => row.subject);
  }
}

export function fallbackNormalize(input: string): NormalizedDomain | null {
  let text = input.trim().toLowerCase();
  if (text.endsWith('.')) text = text.slice(0, -1);
  if (!text) return null;
  const ascii = domainToASCII(text);
  if (!ascii || ascii.length > 253 || !ASCII_DOMAIN.test(ascii)) return null;
  const labels = ascii.split('.');
  if (labels.some((label) => label.length === 0 || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return null;
  const [label, ...rest] = labels;
  return {
    ascii,
    unicode: domainToUnicode(ascii) || ascii,
    label: label!,
    suffix: rest.join('.'),
    isIdn: labels.some((l) => l.startsWith('xn--')),
  };
}
