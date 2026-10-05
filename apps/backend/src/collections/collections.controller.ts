import { Controller } from '@nestjs/common';
import { ApiInput, ApiRoute, type RouteInput } from '../core/route.js';
import { ok, paged } from '../core/envelope.js';
import { CollectionsService } from './collections.service.js';
import { CriteriaService } from './criteria.service.js';
import { PresetsService } from './presets.service.js';
import { pageWindow } from '../evidence/paging.js';

@Controller()
export class CollectionsController {
  constructor(
    private readonly collections: CollectionsService,
    private readonly criteria: CriteriaService,
    private readonly presets: PresetsService,
  ) {}

  @ApiRoute('listCollections')
  listCollections(@ApiInput() input: RouteInput<'listCollections'>) {
    const page = this.collections.list(input.query.cursor, input.query.limit);
    return paged(page.items, page.nextCursor, page.total);
  }

  @ApiRoute('createCollection')
  createCollection(@ApiInput() input: RouteInput<'createCollection'>) {
    return ok(this.collections.create(input.body));
  }

  @ApiRoute('getCollection')
  getCollection(@ApiInput() input: RouteInput<'getCollection'>) {
    return ok(this.collections.get(input.params.id));
  }

  @ApiRoute('patchCollection')
  patchCollection(@ApiInput() input: RouteInput<'patchCollection'>) {
    return ok(this.collections.patch(input.params.id, input.body));
  }

  @ApiRoute('deleteCollection')
  deleteCollection(@ApiInput() input: RouteInput<'deleteCollection'>) {
    this.collections.delete(input.params.id);
    return ok({ ok: true as const });
  }

  @ApiRoute('listCollectionEntries')
  listCollectionEntries(@ApiInput() input: RouteInput<'listCollectionEntries'>) {
    const page = this.collections.entries(input.params.id, input.query.cursor, input.query.limit);
    return paged(page.items, page.nextCursor, page.total);
  }

  @ApiRoute('addCollectionEntries')
  addCollectionEntries(@ApiInput() input: RouteInput<'addCollectionEntries'>) {
    return ok(this.collections.addEntries(input.params.id, input.body));
  }

  @ApiRoute('removeCollectionEntries')
  removeCollectionEntries(@ApiInput() input: RouteInput<'removeCollectionEntries'>) {
    return ok(this.collections.removeEntries(input.params.id, input.body.domains));
  }

  @ApiRoute('patchCollectionEntry')
  patchCollectionEntry(@ApiInput() input: RouteInput<'patchCollectionEntry'>) {
    this.collections.patchEntry(input.params.id, input.params.domain, input.body.notes);
    return ok({ ok: true as const });
  }

  @ApiRoute('listCriteria')
  listCriteria(@ApiInput() input: RouteInput<'listCriteria'>) {
    return slice(this.criteria.list(), input.query.cursor, input.query.limit);
  }

  @ApiRoute('createCriteria')
  createCriteria(@ApiInput() input: RouteInput<'createCriteria'>) {
    return ok(this.criteria.create(input.body));
  }

  @ApiRoute('getCriteria')
  getCriteria(@ApiInput() input: RouteInput<'getCriteria'>) {
    return ok(this.criteria.get(input.params.id));
  }

  @ApiRoute('putCriteria')
  putCriteria(@ApiInput() input: RouteInput<'putCriteria'>) {
    return ok(this.criteria.replace(input.params.id, input.body));
  }

  @ApiRoute('deleteCriteria')
  deleteCriteria(@ApiInput() input: RouteInput<'deleteCriteria'>) {
    this.criteria.delete(input.params.id);
    return ok({ ok: true as const });
  }

  @ApiRoute('listPresets')
  listPresets(@ApiInput() input: RouteInput<'listPresets'>) {
    return slice(this.presets.list(), input.query.cursor, input.query.limit);
  }

  @ApiRoute('createPreset')
  createPreset(@ApiInput() input: RouteInput<'createPreset'>) {
    return ok(this.presets.create(input.body));
  }

  @ApiRoute('deletePreset')
  deletePreset(@ApiInput() input: RouteInput<'deletePreset'>) {
    this.presets.delete(input.params.id);
    return ok({ ok: true as const });
  }
}

/** Cursor paging over a small list that is cheap to load whole. */
function slice<T>(items: T[], cursor: string | undefined, limit: number) {
  const page = pageWindow(cursor, limit);
  const data = items.slice(page.offset, page.offset + page.limit);
  return paged(data, page.next(data.length, items.length), items.length);
}
