import { Global, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { NameCheckService } from '@domain-scout/contracts';
import { NameCheckCatalog } from '../core/ports.js';
import { OperationRegistry } from '../jobs/operation-registry.js';
import { DiagnosticHandler } from './diagnostic.handler.js';
import { EnrichmentController } from './enrichment.controller.js';
import { NameCheckHandler } from './name-check.handler.js';
import { serviceManifest } from './name-check.services.js';
import {
  DNS_TRANSPORT,
  ENRICHMENT_FETCH,
  HTTP_PROBE,
  NodeDnsTransport,
  TLS_PROBE,
  defaultFetch,
  nodeHttpProbe,
  nodeTlsProbe,
} from './transports.js';

@Injectable()
export class NameCheckCatalogService extends NameCheckCatalog {
  services(): NameCheckService[] {
    return serviceManifest();
  }
}

/** Requested name checks and DNS/DNSSEC/TLS/HTTP diagnostics. Global so NameCheckCatalog is injectable anywhere. */
@Global()
@Module({
  controllers: [EnrichmentController],
  providers: [
    { provide: ENRICHMENT_FETCH, useValue: defaultFetch },
    { provide: DNS_TRANSPORT, useFactory: () => new NodeDnsTransport() },
    { provide: TLS_PROBE, useValue: nodeTlsProbe },
    { provide: HTTP_PROBE, useValue: nodeHttpProbe },
    NameCheckHandler,
    DiagnosticHandler,
    { provide: NameCheckCatalog, useClass: NameCheckCatalogService },
  ],
  exports: [NameCheckCatalog],
})
export class EnrichmentModule implements OnModuleInit {
  constructor(
    private readonly operations: OperationRegistry,
    private readonly nameChecks: NameCheckHandler,
    private readonly diagnostics: DiagnosticHandler,
  ) {}

  onModuleInit() {
    this.operations.register(this.nameChecks);
    this.operations.register(this.diagnostics);
  }
}
