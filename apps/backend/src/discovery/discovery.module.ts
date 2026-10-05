import { Module } from '@nestjs/common';
import { GenerationController } from './generation.controller.js';
import { GenerationService } from './generation.service.js';
import { ThemeLibrary } from './themes.js';

/** Local candidate generation and bundled themes. Makes no network requests. */
@Module({
  controllers: [GenerationController],
  providers: [{ provide: ThemeLibrary, useFactory: () => new ThemeLibrary() }, GenerationService],
  exports: [GenerationService],
})
export class DiscoveryModule {}
