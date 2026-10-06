import { Injectable, Optional } from '@nestjs/common';
import type { Comparison, ComparisonRequest, ComparisonRow, PurchasePath } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { InputPreviewer } from '../core/ports.js';
import { SettingsService } from '../system/settings.service.js';
import { ProvidersService } from '../providers/providers.service.js';
import { computeRow, rankRows } from './comparison.js';
import { compare } from './money.js';
import { requireDomain } from './domain.js';
import { OffersService, type PricedOffer } from './offers.service.js';

/** Ownership cost comparisons from retained offers; no provider is contacted. */
@Injectable()
export class ComparisonService {
  constructor(
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly providers: ProvidersService,
    private readonly offers: OffersService,
    @Optional() private readonly previewer?: InputPreviewer,
  ) {}

  create(request: ComparisonRequest): Comparison {
    const horizonYears = request.horizonYears ?? this.settings.get().comparison.horizonYears;
    const path: PurchasePath = request.purchasePath ?? 'new_registration';
    // Omitted uses the configured comparison currency; an explicit null keeps original currencies.
    const currency = request.currency === undefined ? this.settings.get().comparison.currency : request.currency;
    const fxRates = this.settings.get().fxRates;
    const rows: ComparisonRow[] = [];
    let sawPublished = false;

    for (const raw of [...new Set(request.domains)]) {
      const ref = requireDomain(raw, this.previewer ?? null);
      for (const manifest of this.candidates(ref.suffix, request.providerIds)) {
        const picked = this.pick(manifest.id, ref.ascii, ref.suffix, path, request.region ?? null, currency);
        if (picked?.offer.kind === 'published') sawPublished = true;
        const link = path === 'aftermarket' ? null : this.providers.destination(manifest.id, ref.ascii, path);
        const destination = path === 'aftermarket' ? (picked?.offer.destination?.url ?? null) : (link?.url ?? null);
        const row = computeRow(picked?.offer ?? null, picked?.promotional ?? false, {
          domain: ref.ascii,
          providerId: manifest.id,
          path,
          horizonYears,
          currency,
          fxRates,
          destination,
          now: this.clock.now(),
        });
        if (picked?.regionNote) row.notes.push(picked.regionNote);
        if (!destination && path !== 'new_registration') row.notes.push(`No verified ${path.replace('_', ' ')} destination for this provider`);
        rows.push(row);
      }
    }

    const ranked = rankRows(rows);
    const preferred = new Set(this.providers.manifests().filter((m) => this.providers.row(m.id).preferred === 1).map((m) => m.id));
    // Ranked rows first; unranked rows (e.g. published prices with unknown premium status) still
    // sort by their known amount within a currency so the cheapest appears first. A preference only
    // breaks ties and never moves a provider above a cheaper comparable one.
    const amount = (row: (typeof ranked.rows)[number]) => row.horizonTotal ?? row.initialCommitment;
    ranked.rows.sort(
      (a, b) =>
        a.domain.localeCompare(b.domain) ||
        (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
        byAmount(amount(a), a.currency, amount(b), b.currency) ||
        Number(preferred.has(b.providerId)) - Number(preferred.has(a.providerId)) ||
        a.providerId.localeCompare(b.providerId),
    );

    const limits = [
      'Rows marked subtotalOnly leave out tax or fees whose amounts are unknown: they rank only as base subtotals (lowestSubtotal), never as a confirmed cheapest total.',
      'Future renewal prices are estimates based on current renewal prices.',
      'Rows are ranked only within the same domain, currency and fee/tax basis; incomplete, expired and unpriced rows stay visible but unranked.',
      ...ranked.limits,
    ];
    if (sawPublished) limits.push('Published catalog prices assume a standard name and are not exact-name quotes.');
    if (currency) limits.push(`Conversion to ${currency} uses only rates configured in settings, with their source and time.`);
    return { horizonYears, purchasePath: path, currency, generatedAt: this.clock.iso(), rows: ranked.rows, cheapest: ranked.cheapest, lowestSubtotal: ranked.lowestSubtotal, limits };
  }

  /** Requested providers, or enabled named providers plus directory entries that list the suffix. */
  private candidates(suffix: string, providerIds: string[] | undefined) {
    if (providerIds?.length) return providerIds.map((id) => this.providers.require(id));
    return this.providers.manifests().filter((m) => {
      if (!this.providers.isEnabled(m.id)) return false;
      const support = this.providers.supportsSuffix(m, suffix);
      return m.kind === 'directory' ? support === 'yes' : support !== 'no';
    });
  }

  /** An exact quote for the domain and path wins over the provider's published suffix price. */
  private pick(
    providerId: string,
    domain: string,
    suffix: string,
    path: PurchasePath,
    region: string | null,
    currency: string | null,
  ): (PricedOffer & { regionNote?: string }) | null {
    const quotePath: PurchasePath = path === 'renewal' ? 'new_registration' : path;
    const candidates = [
      this.offers.latestQuote(providerId, domain, quotePath),
      path === 'aftermarket' ? null : this.offers.latestPublished(providerId, suffix, currency),
    ].filter((c): c is PricedOffer => c !== null && c.offer.freshness !== 'expired');
    const expired = this.offers.latestQuote(providerId, domain, quotePath);
    const pool = candidates.length ? candidates : expired ? [expired] : [];
    for (const candidate of pool) {
      if (!region || candidate.offer.region === region) return candidate;
      if (candidate.offer.region === null) return { ...candidate, regionNote: `The source does not state a region; ${region} was requested` };
    }
    return null;
  }
}

/** Orders known amounts ascending within one currency; unknown amounts and other currencies keep their place. */
function byAmount(a: string | null, aCurrency: string | null, b: string | null, bCurrency: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (aCurrency !== bCurrency) return 0;
  return compare(a, b);
}
