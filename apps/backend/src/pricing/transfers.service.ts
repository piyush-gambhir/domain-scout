import { Injectable, Optional } from '@nestjs/common';
import type { RegistryObservation, TransferOption } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { InputPreviewer } from '../core/ports.js';
import { EvidenceRepository, hydrateObservation } from '../storage/evidence.js';
import { ProvidersService } from '../providers/providers.service.js';
import { requireDomain } from './domain.js';
import { OffersService } from './offers.service.js';

/** Registry statuses that bear on transfers (EPP status values, case-insensitive). */
const TRANSFER_STATUS = /transferprohibited|pendingtransfer|pendingdelete|redemptionperiod|serverhold|clienthold|pendingrestore/i;

const ALWAYS_UNKNOWN = [
  'Authorization code availability from the current registrar',
  'Registrar-specific locks or waiting periods after registration or a prior transfer',
  'Account eligibility at the receiving provider',
];

/**
 * Read-only transfer comparison from retained data: transfer prices (exact transfer quotes, else the
 * provider's published transfer price for the suffix) and sourced eligibility facts from the latest
 * registry observation. Authorization codes are never requested and no transfer is started.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly clock: Clock,
    private readonly evidence: EvidenceRepository,
    private readonly providers: ProvidersService,
    private readonly offers: OffersService,
    @Optional() private readonly previewer?: InputPreviewer,
  ) {}

  options(name: string): TransferOption[] {
    const ref = requireDomain(name, this.previewer ?? null);
    const eligibility = this.eligibility(ref.ascii);
    const out: TransferOption[] = [];
    for (const manifest of this.providers.manifests()) {
      if (manifest.kind !== 'registrar') continue;
      const quote = this.offers.latestQuote(manifest.id, ref.ascii, 'transfer');
      const published = this.offers.latestPublished(manifest.id, ref.suffix);
      const picked = quote ?? (published?.offer.transfer.amount ? published : null);
      if (!picked) continue;
      const offer = picked.offer;
      const unknown = [...eligibility.unknown];
      if (offer.transfer.includesYears === null) unknown.push('Registration years included with the transfer');
      out.push({
        domain: ref.ascii,
        providerId: manifest.id,
        transfer: offer.transfer.amount ? { amount: offer.transfer.amount, currency: offer.currency } : null,
        includesYears: offer.transfer.includesYears,
        renewal: offer.renewal.amount ? { amount: offer.renewal.amount, currency: offer.currency } : null,
        kind: offer.kind === 'exact_quote' ? 'exact_quote' : 'published',
        freshness: offer.freshness,
        observedAt: offer.observedAt,
        eligibility: { known: eligibility.known, unknown },
        destination: this.providers.destination(manifest.id, ref.ascii, 'transfer')?.url ?? null,
      });
    }
    return out;
  }

  private eligibility(domain: string): { known: string[]; unknown: string[] } {
    const row = this.evidence.latestObservation('registry', domain);
    if (!row) return { known: [], unknown: ['Registry status (no registry observation is retained; run a registry check)', ...ALWAYS_UNKNOWN] };
    const observation = hydrateObservation<RegistryObservation>(row, this.clock.now());
    const via = `${observation.source?.protocol ?? 'registry'} ${observation.source?.destination ?? ''}`.trim();
    const at = `checked ${observation.checkedAt}${observation.freshness === 'fresh' ? '' : `, ${observation.freshness}`}`;
    const known: string[] = [];
    if (observation.outcome === 'no_record') known.push(`The registry reported no registration record (${via}, ${at}); there is nothing to transfer`);
    if (observation.outcome === 'registered') known.push(`The registry shows the domain registered (${via}, ${at})`);
    for (const status of observation.registration?.statuses ?? []) {
      if (TRANSFER_STATUS.test(status.replace(/\s+/g, ''))) known.push(`Registry status ${status} (${via}, ${at})`);
    }
    const unknown = [...ALWAYS_UNKNOWN];
    if (observation.outcome !== 'registered' && observation.outcome !== 'no_record') {
      unknown.unshift(`Registry status (last check was ${observation.outcome})`);
    }
    return { known, unknown };
  }
}
