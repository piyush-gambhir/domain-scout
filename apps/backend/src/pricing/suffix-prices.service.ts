import { Injectable } from '@nestjs/common';
import type { SuffixPriceOffer, SuffixPrices } from '@domain-scout/contracts';
import { ProvidersService } from '../providers/providers.service.js';
import { SettingsService } from '../system/settings.service.js';
import { compare, multiply, sum } from './money.js';
import { OffersService } from './offers.service.js';

/**
 * Published prices of every enabled provider for several suffixes at once, so result rows and the
 * Buy menu need no request per domain. Suffix-level only: no candidate name is involved.
 */
@Injectable()
export class SuffixPricesService {
  constructor(
    private readonly offers: OffersService,
    private readonly providers: ProvidersService,
    private readonly settings: SettingsService,
  ) {}

  list(suffixes: string[], horizonYears?: number): SuffixPrices[] {
    const horizon = horizonYears ?? this.settings.get().comparison.horizonYears;
    const manifests = this.providers.manifests().filter((m) => this.providers.isEnabled(m.id));
    return suffixes.map((suffix) => {
      const offers: SuffixPriceOffer[] = [];
      for (const manifest of manifests) {
        for (const { offer, promotional } of this.offers.publishedVariants(manifest.id, suffix)) {
          const provider = this.providers.toProvider(manifest);
          const registrationYears = offer.registration.years;
          const renewalYears = offer.renewal.years;
          // Only yearly terms extend cleanly to a horizon; anything else stays unknown.
          const extraYears = horizon - registrationYears;
          const horizonTotal =
            offer.registration.amount === null
              ? null
              : extraYears <= 0
                ? offer.registration.amount
                : offer.renewal.amount !== null && renewalYears === 1
                  ? sum(offer.registration.amount, multiply(offer.renewal.amount, extraYears))
                  : null;
          offers.push({
            providerId: manifest.id,
            providerName: provider.name,
            offerId: offer.id,
            kind: offer.kind,
            currency: offer.currency,
            registration: offer.registration.amount,
            registrationYears,
            renewal: offer.renewal.amount,
            renewalYears,
            horizonYears: horizon,
            horizonTotal,
            promotional,
            observedAt: offer.observedAt,
            freshness: offer.freshness,
            purchaseUrlTemplate: provider.purchaseLink?.template ?? null,
            purchaseKind: provider.purchaseLink?.kind ?? null,
          });
        }
      }
      offers.sort((a, b) => {
        if (a.currency !== b.currency) return a.currency.localeCompare(b.currency);
        if (a.registration === null) return b.registration === null ? 0 : 1;
        if (b.registration === null) return -1;
        return compare(a.registration, b.registration);
      });
      return { suffix, offers };
    });
  }
}
