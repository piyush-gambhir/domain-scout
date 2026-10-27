import { Module, type OnModuleInit } from '@nestjs/common';
import { ActivityMonitor } from '../runtime/activity.js';
import { Database } from '../storage/database.js';
import { EvidenceModule } from '../evidence/evidence.module.js';
import { ChangeDetector } from './change-detector.service.js';
import { MonitoringController } from './monitoring.controller.js';
import { WatchScheduler } from './watch-scheduler.service.js';
import { WatchesService } from './watches.service.js';

@Module({
  imports: [EvidenceModule],
  controllers: [MonitoringController],
  providers: [WatchesService, ChangeDetector, WatchScheduler],
  exports: [WatchesService, WatchScheduler],
})
export class MonitoringModule implements OnModuleInit {
  constructor(
    private readonly activity: ActivityMonitor,
    private readonly db: Database,
  ) {}

  /** Active watches only run while the backend does. A restart keeps them, so it is not blocked. */
  onModuleInit() {
    this.activity.addProbe(
      'watches',
      () => {
        const n = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM watches WHERE state = 'active'`)?.n ?? 0;
        return n > 0 ? `${n} active watch${n === 1 ? '' : 'es'}` : null;
      },
      { blocksRestart: false },
    );
  }
}
