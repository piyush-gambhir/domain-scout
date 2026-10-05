import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config.js';
import { Clock, SystemClock } from './clock.js';
import { StorageModule } from '../storage/storage.module.js';
import { SettingsService } from '../system/settings.service.js';
import { EventsService } from '../events/events.service.js';
import { OperationRegistry } from '../jobs/operation-registry.js';

export interface CoreOptions {
  config: AppConfig;
  clock?: Clock;
}

/** Global infrastructure shared by every module: config, clock, database, settings, events, handlers. */
@Global()
@Module({})
export class CoreModule {
  static forRoot(options: CoreOptions): DynamicModule {
    return {
      module: CoreModule,
      imports: [StorageModule],
      providers: [
        { provide: APP_CONFIG, useValue: options.config },
        { provide: Clock, useValue: options.clock ?? new SystemClock() },
        SettingsService,
        EventsService,
        OperationRegistry,
      ],
      exports: [APP_CONFIG, Clock, StorageModule, SettingsService, EventsService, OperationRegistry],
    };
  }
}
