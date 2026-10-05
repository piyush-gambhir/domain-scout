import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CoreModule, type CoreOptions } from './core/core.module.js';
import { AppExceptionFilter } from './core/errors.js';
import { RuntimeModule } from './runtime/runtime.module.js';
import { AuthGuard } from './runtime/auth.guard.js';
import { SystemModule } from './system/system.module.js';
import { EventsModule } from './events/events.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { RegistryModule } from './registry/registry.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { PricingModule } from './pricing/pricing.module.js';
import { CollectionsModule } from './collections/collections.module.js';
import { DiscoveryModule } from './discovery/discovery.module.js';
import { MonitoringModule } from './monitoring/monitoring.module.js';
import { EnrichmentModule } from './enrichment/enrichment.module.js';
import { ExportsModule } from './exports/exports.module.js';
import { EvidenceModule } from './evidence/evidence.module.js';

@Module({})
export class AppModule {
  static forRoot(options: CoreOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(options),
        RuntimeModule,
        SystemModule,
        EventsModule,
        JobsModule,
        RegistryModule,
        ProvidersModule,
        PricingModule,
        CollectionsModule,
        DiscoveryModule,
        MonitoringModule,
        EnrichmentModule,
        ExportsModule,
        EvidenceModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AppExceptionFilter },
        // Local auth for every route; see runtime/auth.guard.ts.
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
