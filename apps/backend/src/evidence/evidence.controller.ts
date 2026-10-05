import { Controller, Optional } from '@nestjs/common';
import type { DomainEvidence } from '@domain-scout/contracts';
import { ProviderDirectory } from '../core/ports.js';
import { ApiInput, ApiRoute, type RouteInput } from '../core/route.js';
import { ok } from '../core/envelope.js';
import { AppError } from '../core/errors.js';
import { Database } from '../storage/database.js';
import { EvidenceReader } from './evidence-reader.service.js';

@Controller()
export class EvidenceController {
  constructor(
    private readonly reader: EvidenceReader,
    private readonly db: Database,
    @Optional() private readonly providers?: ProviderDirectory,
  ) {}

  @ApiRoute('getDomainEvidence')
  getDomainEvidence(@ApiInput() input: RouteInput<'getDomainEvidence'>) {
    const normalized = this.reader.normalize(input.params.name);
    if (!normalized) throw AppError.invalid(`Not a registrable domain: ${input.params.name}`);
    const { ascii: domain, suffix, label } = normalized;
    let providers: DomainEvidence['providers'] = [];
    if (this.providers) {
      try {
        providers = this.providers.forDomain(domain, suffix);
      } catch {
        providers = [];
      }
    }
    const evidence: DomainEvidence = {
      domain,
      unicode: normalized.unicode,
      suffix,
      registry: this.reader.registryHistory(domain),
      confirmations: this.reader.confirmations(domain),
      offers: this.reader.latestOffers(domain, suffix),
      nameChecks: this.reader.nameChecks([label, normalized.unicode.split('.')[0] ?? label]),
      diagnostics: this.reader.diagnostics(domain),
      listings: this.reader.listings(domain),
      collections: this.reader.collectionsFor(domain),
      providers,
    };
    return ok(evidence);
  }

  @ApiRoute('getRawDiagnostic')
  getRawDiagnostic(@ApiInput() input: RouteInput<'getRawDiagnostic'>) {
    const row = this.db.get<{ observation_id: string; content_type: string | null; body: string; truncated: number }>(
      'SELECT observation_id, content_type, body, truncated FROM raw_diagnostics WHERE observation_id = ?',
      [input.params.id],
    );
    if (!row) throw AppError.notFound('Raw diagnostic');
    return ok({
      observationId: row.observation_id,
      contentType: row.content_type,
      body: row.body,
      truncated: row.truncated === 1,
    });
  }
}
