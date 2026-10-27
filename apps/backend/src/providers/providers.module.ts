import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { ProviderDirectory } from '../core/ports.js';
import { ActivityMonitor } from '../runtime/activity.js';
import { CatalogService } from './catalog.service.js';
import { CREDENTIAL_ENV, CredentialStore } from './credentials.js';
import {
  AftermarketHandler,
  CatalogHandler,
  ProviderCheckHandler,
  ProviderHandlersRegistrar,
  QuoteHandler,
  TransferHandler,
} from './handlers.js';
import { ProviderDirectoryService } from './provider-directory.js';
import { ProvidersController } from './providers.controller.js';
import { ProvidersService } from './providers.service.js';
import { FetchProviderTransport, ProviderTransport } from './transport.js';

/**
 * Provider manifests, credentials, adapters, catalogs and the provider_check, quote, transfer,
 * aftermarket and catalog handlers. Tests replace ProviderTransport (and CREDENTIAL_ENV) through
 * Nest overrides so no test reaches a provider.
 */
@Global()
@Module({
  controllers: [ProvidersController],
  providers: [
    { provide: ProviderTransport, useClass: FetchProviderTransport },
    { provide: CREDENTIAL_ENV, useValue: process.env },
    CredentialStore,
    ProvidersService,
    CatalogService,
    ProviderDirectoryService,
    { provide: ProviderDirectory, useExisting: ProviderDirectoryService },
    ProviderCheckHandler,
    QuoteHandler,
    TransferHandler,
    AftermarketHandler,
    CatalogHandler,
    ProviderHandlersRegistrar,
  ],
  exports: [ProviderTransport, CredentialStore, ProvidersService, CatalogService, ProviderDirectory, ProviderDirectoryService],
})
export class ProvidersModule implements OnModuleInit {
  constructor(
    private readonly activity: ActivityMonitor,
    private readonly credentials: CredentialStore,
  ) {}

  /** Session-only credentials live in this process; stopping it would silently drop them. */
  onModuleInit() {
    this.activity.addProbe('credentials', () => {
      const ids = this.credentials.sessionProviders();
      return ids.length > 0 ? `session-only credentials for ${ids.join(', ')}` : null;
    });
  }
}
