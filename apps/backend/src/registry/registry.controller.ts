import { Controller } from '@nestjs/common';
import { ApiInput, ApiRoute, type RouteInput } from '../core/route.js';
import { ok, paged } from '../core/envelope.js';
import { CoverageService } from './coverage.service.js';
import { InputPreviewService } from './input/input-preview.service.js';
import { RoutesService } from './routes.service.js';

/** Input preview and registry coverage. Method order matters: /coverage/summary precedes /coverage/:suffix. */
@Controller()
export class RegistryController {
  constructor(
    private readonly inputs: InputPreviewService,
    private readonly coverage: CoverageService,
    private readonly routes: RoutesService,
  ) {}

  @ApiRoute('previewInput')
  previewInput(@ApiInput() input: RouteInput<'previewInput'>) {
    return ok(this.inputs.preview(input.body));
  }

  @ApiRoute('listCoverage')
  listCoverage(@ApiInput() input: RouteInput<'listCoverage'>) {
    const { items, nextCursor, total } = this.coverage.list(input.query);
    return paged(items, nextCursor, total);
  }

  @ApiRoute('getCoverageSummary')
  getCoverageSummary() {
    return ok(this.coverage.summary());
  }

  @ApiRoute('refreshCoverage')
  async refreshCoverage() {
    await this.routes.refresh();
    this.coverage.sync();
    return ok(this.coverage.summary());
  }

  @ApiRoute('getSuffixCoverage')
  getSuffixCoverage(@ApiInput() input: RouteInput<'getSuffixCoverage'>) {
    return ok(this.coverage.get(input.params.suffix));
  }
}
