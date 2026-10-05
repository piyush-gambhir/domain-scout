import { Module } from '@nestjs/common';
import { CapabilitiesService } from './capabilities.service.js';
import { DataService } from './data.service.js';
import { HealthController } from './health.controller.js';
import { HistoryService } from './history.service.js';
import { SystemController } from './system.controller.js';

@Module({
  controllers: [HealthController, SystemController],
  providers: [CapabilitiesService, HistoryService, DataService],
})
export class SystemModule {}
