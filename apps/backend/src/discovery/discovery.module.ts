import { Module } from '@nestjs/common';
import { GenerationController } from './generation.controller.js';
import { GenerationService } from './generation.service.js';
import { ThemeLibrary } from './themes.js';

/** Local candidate generation and bundled themes. Makes no network requests. */
@Module({
  controllers: [GenerationController],
  providers: [
    {
      provide: ThemeLibrary,
      // Read at startup: an npm upgrade may replace the installed files while the backend runs.
      useFactory: () => {
        const library = new ThemeLibrary();
        library.all();
        return library;
      },
    },
    GenerationService,
  ],
  exports: [GenerationService],
})
export class DiscoveryModule {}
