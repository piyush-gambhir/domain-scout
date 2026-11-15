import { Module } from '@nestjs/common';
import { GenerationController } from './generation.controller.js';
import { GenerationService } from './generation.service.js';
import { ThemeLibrary } from './themes.js';


@Module({
  controllers: [GenerationController],
  providers: [
    {
      provide: ThemeLibrary,

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
