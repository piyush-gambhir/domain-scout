import { Injectable, Optional } from '@nestjs/common';
import type { AftermarketListing } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { InputPreviewer } from '../core/ports.js';
import { EvidenceRepository, hydrateObservation } from '../storage/evidence.js';
import { LINK_ONLY_MARKETPLACES } from '../providers/marketplaces.js';
import { ProvidersService } from '../providers/providers.service.js';
import { requireDomain } from './domain.js';

export interface AftermarketSourceView {
  id: string;
  name: string;
  supported: boolean;
  requiresCredentials: boolean;
  searchUrlTemplate: string | null;
  reason: string | null;
}

/** Aftermarket sources and retained listing evidence. Listings never count as purchase confirmation. */
@Injectable()
export class AftermarketService {
  constructor(
    private readonly clock: Clock,
    private readonly evidence: EvidenceRepository,
    private readonly providers: ProvidersService,
    @Optional() private readonly previewer?: InputPreviewer,
  ) {}

  /**
   * Provider-based sources with an implemented listing lookup (credentials required), then
   * marketplaces as link-only entries: unsupported, with the reason and their website.
   */
  sources(): AftermarketSourceView[] {
    const providerSources = this.providers
      .manifests()
      .filter((m) => m.kind === 'registrar' && m.capabilities.aftermarket.level !== 'unsupported')
      .map((m) => ({
        id: m.id,
        name: `${m.name} aftermarket`,
        supported: true,
        requiresCredentials: m.capabilities.aftermarket.requiresCredentials,
        searchUrlTemplate: null,
        reason: m.capabilities.aftermarket.notes,
      }));
    const marketplaces = Object.entries(LINK_ONLY_MARKETPLACES).map(([id, m]) => ({
      id,
      name: m.name,
      supported: false,
      requiresCredentials: false,
      // The website only: no search template was verified for these marketplaces.
      searchUrlTemplate: m.website,
      reason: m.reason,
    }));
    return [...providerSources, ...marketplaces];
  }

  listings(name: string): AftermarketListing[] {
    const ref = requireDomain(name, this.previewer ?? null);
    const now = this.clock.now();
    return this.evidence.observations('listing', ref.ascii, 200).map((row) => hydrateObservation<AftermarketListing>(row, now));
  }
}
