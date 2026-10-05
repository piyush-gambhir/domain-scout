import { Controller, Headers, Optional } from '@nestjs/common';
import { ApiInput, ApiRoute, type RouteInput } from '../core/route.js';
import { decodeCursor, encodeCursor, ok, paged } from '../core/envelope.js';
import { AppError } from '../core/errors.js';
import { JobSubmitter } from '../core/ports.js';
import { OffersService } from '../pricing/offers.service.js';
import { ProvidersService } from './providers.service.js';

@Controller()
export class ProvidersController {
  constructor(
    private readonly providers: ProvidersService,
    private readonly offers: OffersService,
    @Optional() private readonly jobs?: JobSubmitter,
  ) {}

  @ApiRoute('listProviders')
  list(@ApiInput() input: RouteInput<'listProviders'>) {
    const all = this.providers.list();
    const offset = decodeCursor<{ o: number }>(input.query.cursor)?.o ?? 0;
    const page = all.slice(offset, offset + input.query.limit);
    const next = offset + page.length < all.length ? encodeCursor({ o: offset + page.length }) : null;
    return paged(page, next, all.length);
  }

  @ApiRoute('getProvider')
  get(@ApiInput() input: RouteInput<'getProvider'>) {
    return ok(this.providers.get(input.params.id));
  }

  @ApiRoute('patchProvider')
  patch(@ApiInput() input: RouteInput<'patchProvider'>) {
    return ok(this.providers.patch(input.params.id, input.body));
  }

  @ApiRoute('listProviderCatalog')
  catalog(@ApiInput() input: RouteInput<'listProviderCatalog'>) {
    this.providers.require(input.params.id);
    const { items, nextCursor, total } = this.offers.providerCatalog(input.params.id, input.query.suffix ?? null, input.query.cursor ?? null, input.query.limit);
    return paged(items, nextCursor, total);
  }

  /** Submits a catalog_refresh job; the catalog request sends no candidate names. */
  @ApiRoute('refreshProviderCatalog')
  refresh(@ApiInput() input: RouteInput<'refreshProviderCatalog'>, @Headers('idempotency-key') idempotencyKey?: string) {
    const manifest = this.providers.require(input.params.id);
    if (manifest.capabilities.catalog.level === 'unsupported') {
      throw new AppError('unsupported', `${manifest.name} has no catalog: ${manifest.capabilities.catalog.notes ?? 'unsupported'}`, {
        source: `provider:${manifest.id}`,
      });
    }
    if (!this.jobs) throw new AppError('unavailable', 'The jobs engine is not available', { retryable: true });
    const job = this.jobs.submit(
      { type: 'catalog_refresh', providerIds: [manifest.id], label: `${manifest.name} catalog refresh` },
      { idempotencyKey, operationId: 'refreshProviderCatalog' },
    );
    return ok(job);
  }

  @ApiRoute('putProviderCredentials')
  putCredentials(@ApiInput() input: RouteInput<'putProviderCredentials'>) {
    return ok(this.providers.putCredentials(input.params.id, input.body.values, input.body.storage));
  }

  @ApiRoute('deleteProviderCredentials')
  deleteCredentials(@ApiInput() input: RouteInput<'deleteProviderCredentials'>) {
    return ok(this.providers.deleteCredentials(input.params.id));
  }

  @ApiRoute('testProviderCredentials')
  async testCredentials(@ApiInput() input: RouteInput<'testProviderCredentials'>) {
    return ok(await this.providers.testCredentials(input.params.id));
  }
}
