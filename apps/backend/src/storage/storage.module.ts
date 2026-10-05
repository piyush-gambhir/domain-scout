import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { join } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../core/config.js';
import { Clock, SystemClock } from '../core/clock.js';
import { Database } from './database.js';
import { EvidenceRepository } from './evidence.js';

export const DATABASE_FILE = 'domain-scout.sqlite';

@Global()
@Module({
  providers: [
    {
      provide: Database,
      inject: [APP_CONFIG, Clock],
      useFactory: (config: AppConfig, clock: Clock) => {
        const db = new Database(config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, DATABASE_FILE));
        db.migrate(clock.iso());
        return db;
      },
    },
    EvidenceRepository,
  ],
  exports: [Database, EvidenceRepository],
})
export class StorageModule implements OnApplicationShutdown {
  constructor(@Inject(Database) private readonly db: Database) {}

  onApplicationShutdown() {
    try {
      this.db.checkpoint();
    } finally {
      this.db.close();
    }
  }
}

export { Clock, SystemClock };
