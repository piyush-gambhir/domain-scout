import { Module } from '@nestjs/common';
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
export class MonitoringModule {}
