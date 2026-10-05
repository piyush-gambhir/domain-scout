import { Module } from '@nestjs/common';
import { EvidenceController } from './evidence.controller.js';
import { EvidenceReader } from './evidence-reader.service.js';

@Module({
  controllers: [EvidenceController],
  providers: [EvidenceReader],
  exports: [EvidenceReader],
})
export class EvidenceModule {}
