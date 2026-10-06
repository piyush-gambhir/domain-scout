import { Global, Module } from '@nestjs/common';
import { AftermarketService } from './aftermarket.service.js';
import { ComparisonService } from './comparison.service.js';
import { HistoryService } from './history.service.js';
import { OffersService } from './offers.service.js';
import { PortfolioService } from './portfolio.service.js';
import { SuffixPricesService } from './suffix-prices.service.js';
import { PricingController } from './pricing.controller.js';
import { TransfersService } from './transfers.service.js';

/** Offers queries, comparisons, price history, transfer options, aftermarket evidence and portfolio. */
@Global()
@Module({
  controllers: [PricingController],
  providers: [OffersService, ComparisonService, HistoryService, TransfersService, AftermarketService, PortfolioService, SuffixPricesService],
  exports: [OffersService, ComparisonService, HistoryService, TransfersService, AftermarketService, PortfolioService],
})
export class PricingModule {}
