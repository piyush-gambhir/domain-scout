import { Controller, Headers } from '@nestjs/common';
import { ApiInput, ApiRoute, type RouteInput } from '../core/route.js';
import { ok, paged } from '../core/envelope.js';
import { WatchScheduler } from './watch-scheduler.service.js';
import { WatchesService } from './watches.service.js';

@Controller()
export class MonitoringController {
  constructor(
    private readonly watches: WatchesService,
    private readonly scheduler: WatchScheduler,
  ) {}

  @ApiRoute('listWatches')
  listWatches(@ApiInput() input: RouteInput<'listWatches'>) {
    const page = this.watches.list(input.query.cursor, input.query.limit);
    return paged(page.items, page.nextCursor, page.total);
  }

  @ApiRoute('createWatch')
  createWatch(@ApiInput() input: RouteInput<'createWatch'>) {
    return ok(this.watches.create(input.body));
  }

  @ApiRoute('getWatch')
  getWatch(@ApiInput() input: RouteInput<'getWatch'>) {
    return ok(this.watches.get(input.params.id));
  }

  @ApiRoute('patchWatch')
  patchWatch(@ApiInput() input: RouteInput<'patchWatch'>) {
    return ok(this.watches.patch(input.params.id, input.body));
  }

  @ApiRoute('deleteWatch')
  deleteWatch(@ApiInput() input: RouteInput<'deleteWatch'>) {
    this.watches.delete(input.params.id);
    return ok({ ok: true as const });
  }

  @ApiRoute('pauseWatch')
  pauseWatch(@ApiInput() input: RouteInput<'pauseWatch'>) {
    return ok(this.watches.pause(input.params.id));
  }

  @ApiRoute('resumeWatch')
  resumeWatch(@ApiInput() input: RouteInput<'resumeWatch'>) {
    return ok(this.watches.resume(input.params.id));
  }

  @ApiRoute('runWatch')
  runWatch(@ApiInput() input: RouteInput<'runWatch'>, @Headers('idempotency-key') idempotencyKey?: string) {
    return ok(this.scheduler.runNow(input.params.id, idempotencyKey?.trim() || undefined));
  }

  @ApiRoute('listWatchRuns')
  listWatchRuns(@ApiInput() input: RouteInput<'listWatchRuns'>) {
    const page = this.watches.runs(input.params.id, input.query.cursor, input.query.limit);
    return paged(page.items, page.nextCursor, page.total);
  }

  @ApiRoute('listNotices')
  listNotices(@ApiInput() input: RouteInput<'listNotices'>) {
    const page = this.watches.notices(input.query);
    return paged(page.items, page.nextCursor, page.total);
  }

  @ApiRoute('markNoticesRead')
  markNoticesRead(@ApiInput() input: RouteInput<'markNoticesRead'>) {
    this.watches.markRead(input.body);
    return ok({ ok: true as const });
  }
}
