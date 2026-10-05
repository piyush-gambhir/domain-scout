import { Module } from '@nestjs/common';
import { EvidenceModule } from '../evidence/evidence.module.js';
import { ArtifactStore } from './artifact-store.service.js';
import { ExportsController } from './exports.controller.js';
import { ExportsService } from './exports.service.js';
import { ScopeResolver } from './scope-resolver.service.js';
import { SnapshotsService } from './snapshots.service.js';

@Module({
  imports: [EvidenceModule],
  controllers: [ExportsController],
  providers: [ArtifactStore, ScopeResolver, ExportsService, SnapshotsService],
  exports: [ExportsService, SnapshotsService],
})
export class ExportsModule {}
