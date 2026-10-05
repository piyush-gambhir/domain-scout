import { Controller, Headers } from '@nestjs/common';
import { resultFilterFromQuery, type OperationId } from '@domain-scout/contracts';
import { ok, paged } from '../core/envelope.js';
import { ApiInput, ApiRoute, type RouteInput } from '../core/route.js';
import type { SubmitOptions } from '../core/ports.js';
import { idempotencyKey } from './idempotency.js';
import { JobsService } from './jobs.service.js';
import { JobResultsService } from './results.service.js';

const IDEMPOTENCY_HEADER = 'idempotency-key';

function idem(operationId: OperationId, header: string | undefined): SubmitOptions {
  return { operationId, idempotencyKey: idempotencyKey(header) };
}

@Controller()
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly results: JobResultsService,
  ) {}

  @ApiRoute('createJob')
  create(@ApiInput() input: RouteInput<'createJob'>, @Headers(IDEMPOTENCY_HEADER) key?: string) {
    return ok(this.jobs.submit(input.body, idem('createJob', key)));
  }

  @ApiRoute('listJobs')
  list(@ApiInput() input: RouteInput<'listJobs'>) {
    const page = this.jobs.list(input.query);
    return paged(page.items, page.nextCursor, page.total);
  }

  @ApiRoute('getJob')
  get(@ApiInput() input: RouteInput<'getJob'>) {
    return ok(this.jobs.get(input.params.id));
  }

  @ApiRoute('listJobResults')
  listResults(@ApiInput() input: RouteInput<'listJobResults'>) {
    const page = this.results.list(input.params.id, resultFilterFromQuery(input.query), input.query.cursor, input.query.limit);
    return paged(page.items, page.nextCursor, page.total);
  }

  @ApiRoute('cancelJob')
  cancel(@ApiInput() input: RouteInput<'cancelJob'>) {
    return ok(this.jobs.cancel(input.params.id));
  }

  @ApiRoute('resumeJob')
  resume(@ApiInput() input: RouteInput<'resumeJob'>) {
    return ok(this.jobs.resume(input.params.id));
  }

  @ApiRoute('retryJob')
  retry(@ApiInput() input: RouteInput<'retryJob'>, @Headers(IDEMPOTENCY_HEADER) key?: string) {
    return ok(this.jobs.retry(input.params.id, input.body, idem('retryJob', key)));
  }

  @ApiRoute('deleteJob')
  remove(@ApiInput() input: RouteInput<'deleteJob'>) {
    this.jobs.remove(input.params.id);
    return ok({ ok: true as const });
  }

  @ApiRoute('createRecheck')
  recheck(@ApiInput() input: RouteInput<'createRecheck'>, @Headers(IDEMPOTENCY_HEADER) key?: string) {
    return ok(this.jobs.recheck(input.body, idem('createRecheck', key)));
  }
}

/** Operation-specific submission endpoints; each maps its body to the matching CreateJobRequest. */
@Controller()
export class JobOperationsController {
  constructor(private readonly jobs: JobsService) {}

  @ApiRoute('createQuotes')
  quotes(@ApiInput() input: RouteInput<'createQuotes'>, @Headers(IDEMPOTENCY_HEADER) key?: string) {
    return ok(this.jobs.submit({ type: 'quote', ...input.body }, idem('createQuotes', key)));
  }

  @ApiRoute('createProviderChecks')
  providerChecks(@ApiInput() input: RouteInput<'createProviderChecks'>, @Headers(IDEMPOTENCY_HEADER) key?: string) {
    return ok(this.jobs.submit({ type: 'provider_check', ...input.body }, idem('createProviderChecks', key)));
  }

  @ApiRoute('createTransfers')
  transfers(@ApiInput() input: RouteInput<'createTransfers'>, @Headers(IDEMPOTENCY_HEADER) key?: string) {
    return ok(this.jobs.submit({ type: 'transfer', ...input.body }, idem('createTransfers', key)));
  }

  @ApiRoute('createAftermarket')
  aftermarket(@ApiInput() input: RouteInput<'createAftermarket'>, @Headers(IDEMPOTENCY_HEADER) key?: string) {
    return ok(this.jobs.submit({ type: 'aftermarket', ...input.body }, idem('createAftermarket', key)));
  }

  @ApiRoute('createNameChecks')
  nameChecks(@ApiInput() input: RouteInput<'createNameChecks'>, @Headers(IDEMPOTENCY_HEADER) key?: string) {
    return ok(this.jobs.submit({ type: 'name_check', ...input.body }, idem('createNameChecks', key)));
  }

  @ApiRoute('createDiagnostics')
  diagnostics(@ApiInput() input: RouteInput<'createDiagnostics'>, @Headers(IDEMPOTENCY_HEADER) key?: string) {
    return ok(this.jobs.submit({ type: 'diagnostics', ...input.body }, idem('createDiagnostics', key)));
  }
}
