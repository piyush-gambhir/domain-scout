import { Controller, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../core/config.js';
import { ok, paged } from '../core/envelope.js';
import { ApiInput, ApiRoute, type RouteInput } from '../core/route.js';
import { AppError } from '../core/errors.js';
import { ActivityMonitor } from '../runtime/activity.js';
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
    private readonly activity: ActivityMonitor,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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

  @ApiRoute('stopService')
  stopService(@Res({ passthrough: true }) res: Response) {
    return this.stopAfterResponse(res);
  }

  /**
   * A newer CLI replacing this (older) backend. Refuses when the caller verified another instance
   * (a concurrent CLI already replaced it) or while work would be lost. Backends that predate this
   * route answer 404, so CLIs keep using them.
   */
  @ApiRoute('stopServiceUnlessBusy')
  stopServiceUnlessBusy(@ApiInput() input: RouteInput<'stopServiceUnlessBusy'>, @Res({ passthrough: true }) res: Response) {
    if (input.body.instanceId.toLowerCase() !== this.config.instanceId.toLowerCase()) {
      throw new AppError('conflict', `This is backend instance ${this.config.instanceId}, not ${input.body.instanceId}`, {
        details: [{ path: 'instanceId', message: 'another backend instance answered' }],
      });
    }
    const blockers = this.activity.blockers('restart', 1);
    if (blockers.length > 0) {
      throw new AppError('conflict', `The backend is busy: ${blockers.map((b) => b.detail).join('; ')}`, {
        details: blockers.map((b) => ({ path: b.name, message: b.detail })),
      });
    }
    return this.stopAfterResponse(res);
  }

  /** Answers 202 first; the stop starts once the response has been flushed (or the client left). */
  private stopAfterResponse(res: Response) {
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
