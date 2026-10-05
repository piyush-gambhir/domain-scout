import { Global, Module } from '@nestjs/common';
import { ProviderDirectory } from '../core/ports.js';
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
export class ProvidersModule {}
