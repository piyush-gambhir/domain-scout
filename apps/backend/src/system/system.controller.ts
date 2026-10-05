import { Controller, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ok, paged } from '../core/envelope.js';
import { ApiInput, ApiRoute, type RouteInput } from '../core/route.js';
import { ShutdownCoordinator } from '../runtime/shutdown.js';
import { CapabilitiesService } from './capabilities.service.js';
import { DataService } from './data.service.js';
import { HistoryService } from './history.service.js';
import { SettingsService } from './settings.service.js';

@Controller()
export class SystemController {
  constructor(
    private readonly capabilities: CapabilitiesService,
    private readonly settings: SettingsService,
    private readonly history: HistoryService,
    private readonly data: DataService,
    private readonly shutdown: ShutdownCoordinator,
  ) {}

  @ApiRoute('getCapabilities')
  getCapabilities() {
    return ok(this.capabilities.get());
  }

  @ApiRoute('getSettings')
  getSettings() {
    return ok(this.settings.get());
  }

  @ApiRoute('patchSettings')
  patchSettings(@ApiInput() input: RouteInput<'patchSettings'>) {
    return ok(this.settings.patch(input.body));
  }

  /** Answers 202 first; the stop starts once the response has been flushed (or the client left). */
  @ApiRoute('stopService')
  stopService(@Res({ passthrough: true }) res: Response) {
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      void this.shutdown.stop('api');
    };
    res.once('finish', start);
    res.once('close', start);
    return ok({ stopping: true as const, graceMs: this.shutdown.graceMs });
  }

  @ApiRoute('listHistory')
  listHistory(@ApiInput() input: RouteInput<'listHistory'>) {
    const { items, nextCursor, total } = this.history.list(input.query);
    return paged(items, nextCursor, total);
  }

  @ApiRoute('getDataInventory')
  getDataInventory() {
    return ok(this.data.inventory());
  }

  @ApiRoute('deleteData')
  deleteData(@ApiInput() input: RouteInput<'deleteData'>) {
    return ok(this.data.delete(input.body));
  }
}
