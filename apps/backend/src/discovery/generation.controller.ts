import { Controller, Inject } from '@nestjs/common';
import { ApiInput, ApiRoute, type RouteInput } from '../core/route.js';
import { ok, paged } from '../core/envelope.js';
import { GenerationService } from './generation.service.js';

@Controller()
export class GenerationController {
  constructor(@Inject(GenerationService) private readonly generation: GenerationService) {}

  @ApiRoute('previewGeneration')
  preview(@ApiInput() input: RouteInput<'previewGeneration'>) {
    return ok(this.generation.preview(input.body));
  }

  @ApiRoute('listGenerationThemes')
  themes() {
    const themes = this.generation.themes();
    return paged(themes, null, themes.length);
  }
}
