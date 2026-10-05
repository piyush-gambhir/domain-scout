import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { CoverageReader, InputPreviewer } from '../core/ports.js';
import { OperationRegistry } from '../jobs/operation-registry.js';
import { CoverageService } from './coverage.service.js';
import { InputPreviewService } from './input/input-preview.service.js';
import { PublishedLimits } from './published-limits.js';
import { FetchHttpTransport, RegistryHttpTransport } from './rdap/http-transport.js';
import { RegistryChecker } from './registry-checker.js';
import { RegistryController } from './registry.controller.js';
import { RegistryOperationHandler } from './registry.handler.js';
import { RoutesService } from './routes.service.js';
import { NetWhoisTransport, WhoisTransport } from './whois/whois-transport.js';

/**
 * Registry discovery: input normalization, routing (IANA RDAP bootstrap plus curated RDAP and WHOIS), RDAP
 * and WHOIS clients with registry-specific classifiers, the `registry` job handler and coverage.
 * Transports are providers so tests replace them with fakes (overrideProvider).
 */
@Global()
@Module({
  controllers: [RegistryController],
  providers: [
    { provide: RegistryHttpTransport, useClass: FetchHttpTransport },
    { provide: WhoisTransport, useClass: NetWhoisTransport },
    InputPreviewService,
    RoutesService,
    CoverageService,
    PublishedLimits,
    RegistryChecker,
    RegistryOperationHandler,
    { provide: InputPreviewer, useExisting: InputPreviewService },
    { provide: CoverageReader, useExisting: CoverageService },
  ],
  exports: [InputPreviewer, CoverageReader, InputPreviewService, CoverageService, RoutesService, RegistryChecker],
})
export class RegistryModule implements OnModuleInit {
  constructor(
    private readonly operations: OperationRegistry,
    private readonly handler: RegistryOperationHandler,
  ) {}

  onModuleInit() {
    this.operations.register(this.handler);
  }
}
