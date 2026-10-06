import { Controller, Optional } from '@nestjs/common';
import { ApiInput, ApiRoute, type RouteInput } from '../core/route.js';
import { decodeCursor, encodeCursor, ok, paged } from '../core/envelope.js';
import { InputPreviewer } from '../core/ports.js';
import { AppError } from '../core/errors.js';
import { AftermarketService } from './aftermarket.service.js';
import { ComparisonService } from './comparison.service.js';
import { requireDomain } from './domain.js';
import { HistoryService } from './history.service.js';
import { OffersService } from './offers.service.js';
import { PortfolioService } from './portfolio.service.js';
import { SuffixPricesService } from './suffix-prices.service.js';
import { TransfersService } from './transfers.service.js';

/** Offset pagination for small, fully computed lists. */
function slice<T>(all: T[], cursor: string | undefined, limit: number) {
  const offset = decodeCursor<{ o: number }>(cursor)?.o ?? 0;
  const items = all.slice(offset, offset + limit);
  return paged(items, offset + items.length < all.length ? encodeCursor({ o: offset + items.length }) : null, all.length);
}

@Controller()
export class PricingController {
  constructor(
    private readonly offers: OffersService,
    private readonly comparisons: ComparisonService,
    private readonly history: HistoryService,
    private readonly transfers: TransfersService,
    private readonly aftermarket: AftermarketService,
    private readonly portfolio: PortfolioService,
    private readonly suffixPrices: SuffixPricesService,
    @Optional() private readonly previewer?: InputPreviewer,
  ) {}

  @ApiRoute('listSuffixPrices')
  prices(@ApiInput() input: RouteInput<'listSuffixPrices'>) {
    const suffixes = [...new Set(input.query.suffixes.split(',').map((s) => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean))];
    if (suffixes.length === 0 || suffixes.length > 100) throw AppError.invalid('Give between 1 and 100 suffixes');
    return ok(this.suffixPrices.list(suffixes, input.query.horizonYears));
  }

  @ApiRoute('listDomainOffers')
  domainOffers(@ApiInput() input: RouteInput<'listDomainOffers'>) {
    const ref = requireDomain(input.params.name, this.previewer ?? null);
    return slice(this.offers.domainOffers(ref.ascii, ref.suffix), input.query.cursor, input.query.limit);
  }

  @ApiRoute('listDomainTransferOptions')
  transferOptions(@ApiInput() input: RouteInput<'listDomainTransferOptions'>) {
    return slice(this.transfers.options(input.params.name), input.query.cursor, input.query.limit);
  }

  @ApiRoute('listDomainListings')
  listings(@ApiInput() input: RouteInput<'listDomainListings'>) {
    return slice(this.aftermarket.listings(input.params.name), input.query.cursor, input.query.limit);
  }

  @ApiRoute('listAftermarketSources')
  sources() {
    const all = this.aftermarket.sources();
    return paged(all, null, all.length);
  }

  @ApiRoute('getPriceHistory')
  priceHistory(@ApiInput() input: RouteInput<'getPriceHistory'>) {
    const { items, nextCursor, total } = this.history.series(input.query);
    return paged(items, nextCursor, total);
  }

  @ApiRoute('createComparison')
  compare(@ApiInput() input: RouteInput<'createComparison'>) {
    return ok(this.comparisons.create(input.body));
  }

  @ApiRoute('listPortfolio')
  listPortfolio(@ApiInput() input: RouteInput<'listPortfolio'>) {
    const { items, nextCursor, total } = this.portfolio.list(input.query.cursor, input.query.limit);
    return paged(items, nextCursor, total);
  }

  @ApiRoute('importPortfolio')
  importPortfolio(@ApiInput() input: RouteInput<'importPortfolio'>) {
    return ok(this.portfolio.import(input.body));
  }

  @ApiRoute('comparePortfolio')
  comparePortfolio(@ApiInput() input: RouteInput<'comparePortfolio'>) {
    const { items, nextCursor, total } = this.portfolio.compare(input.query.cursor, input.query.limit);
    return paged(items, nextCursor, total);
  }

  @ApiRoute('deletePortfolioEntry')
  deletePortfolioEntry(@ApiInput() input: RouteInput<'deletePortfolioEntry'>) {
    this.portfolio.delete(input.params.id);
    return ok({ ok: true as const });
  }
}
