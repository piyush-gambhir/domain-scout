import { Module } from '@nestjs/common';
import { EvidenceModule } from '../evidence/evidence.module.js';
import { CollectionsController } from './collections.controller.js';
import { CollectionsService } from './collections.service.js';
import { CriteriaService } from './criteria.service.js';
import { PresetsService } from './presets.service.js';

@Module({
  imports: [EvidenceModule],
  controllers: [CollectionsController],
  providers: [CollectionsService, CriteriaService, PresetsService],
  exports: [CollectionsService, PresetsService],
})
export class CollectionsModule {}
