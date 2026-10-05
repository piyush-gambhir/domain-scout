import { Controller, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiInput, ApiRoute, type RouteInput } from '../core/route.js';
import { ok, paged } from '../core/envelope.js';
import { pageWindow } from '../evidence/paging.js';
import { ExportsService } from './exports.service.js';
import { SnapshotsService } from './snapshots.service.js';

@Controller()
export class ExportsController {
  constructor(
    private readonly exportsService: ExportsService,
    private readonly snapshots: SnapshotsService,
  ) {}

  @ApiRoute('createExport')
  createExport(@ApiInput() input: RouteInput<'createExport'>) {
    return ok(this.exportsService.create(input.body));
  }

  @ApiRoute('listExports')
  listExports(@ApiInput() input: RouteInput<'listExports'>) {
    return slice(this.exportsService.list(), input.query.cursor, input.query.limit);
  }

  @ApiRoute('getExport')
  getExport(@ApiInput() input: RouteInput<'getExport'>) {
    return ok(this.exportsService.get(input.params.id));
  }

  @ApiRoute('downloadExport')
  downloadExport(@ApiInput() input: RouteInput<'downloadExport'>, @Res() res: Response) {
    send(res, this.exportsService.download(input.params.id));
  }

  @ApiRoute('deleteExport')
  deleteExport(@ApiInput() input: RouteInput<'deleteExport'>) {
    this.exportsService.delete(input.params.id);
    return ok({ ok: true as const });
  }

  @ApiRoute('previewSnapshot')
  previewSnapshot(@ApiInput() input: RouteInput<'previewSnapshot'>) {
    return ok(this.snapshots.preview(input.body));
  }

  @ApiRoute('createSnapshot')
  createSnapshot(@ApiInput() input: RouteInput<'createSnapshot'>) {
    return ok(this.snapshots.create(input.body));
  }

  @ApiRoute('listSnapshots')
  listSnapshots(@ApiInput() input: RouteInput<'listSnapshots'>) {
    return slice(this.snapshots.list(), input.query.cursor, input.query.limit);
  }

  @ApiRoute('getSnapshot')
  getSnapshot(@ApiInput() input: RouteInput<'getSnapshot'>) {
    return ok(this.snapshots.get(input.params.id));
  }

  @ApiRoute('downloadSnapshot')
  downloadSnapshot(@ApiInput() input: RouteInput<'downloadSnapshot'>, @Res() res: Response) {
    send(res, this.snapshots.download(input.params.id, input.query.format));
  }

  @ApiRoute('deleteSnapshot')
  deleteSnapshot(@ApiInput() input: RouteInput<'deleteSnapshot'>) {
    this.snapshots.delete(input.params.id);
    return ok({ ok: true as const });
  }
}

function send(res: Response, file: { body: Buffer; contentType: string; fileName: string }) {
  res.status(200);
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName.replace(/["\\\r\n]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.send(file.body);
}

function slice<T>(items: T[], cursor: string | undefined, limit: number) {
  const page = pageWindow(cursor, limit);
  const data = items.slice(page.offset, page.offset + page.limit);
  return paged(data, page.next(data.length, items.length), items.length);
}
