import { Controller, Headers } from '@nestjs/common';
import { resultFilterFromQuery, type JobOrigin, type OperationId } from '@domain-scout/contracts';
import { ok, paged } from '../core/envelope.js';
import { ApiInput, ApiRoute, type RouteInput } from '../core/route.js';
import type { SubmitOptions } from '../core/ports.js';
import { idempotencyKey } from './idempotency.js';
import { JobsService } from './jobs.service.js';
import { JobResultsService } from './results.service.js';

const IDEMPOTENCY_HEADER = 'idempotency-key';
const CLIENT_HEADER = 'x-domain-scout-client';

type RequestHeaders = Record<string, string | string[] | undefined>;

/** Which client submitted a job, from the X-Domain-Scout-Client header the web UI and CLI send. */
export function clientOrigin(headers: RequestHeaders): JobOrigin {
  const raw = headers[CLIENT_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase();
  return value === 'web' ? 'ui' : value === 'cli' ? 'cli' : 'api';
}

function idem(operationId: OperationId, headers: RequestHeaders): SubmitOptions {
  return { operationId, idempotencyKey: idempotencyKey(headers[IDEMPOTENCY_HEADER]), origin: clientOrigin(headers) };
}

@Controller()
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly results: JobResultsService,
  ) {}

  @ApiRoute('createJob')
  create(@ApiInput() input: RouteInput<'createJob'>, @Headers() headers: RequestHeaders) {
    return ok(this.jobs.submit(input.body, idem('createJob', headers)));
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
  retry(@ApiInput() input: RouteInput<'retryJob'>, @Headers() headers: RequestHeaders) {
    return ok(this.jobs.retry(input.params.id, input.body, idem('retryJob', headers)));
  }

  @ApiRoute('deleteJob')
  remove(@ApiInput() input: RouteInput<'deleteJob'>) {
    this.jobs.remove(input.params.id);
    return ok({ ok: true as const });
  }

  @ApiRoute('createRecheck')
  recheck(@ApiInput() input: RouteInput<'createRecheck'>, @Headers() headers: RequestHeaders) {
    return ok(this.jobs.recheck(input.body, idem('createRecheck', headers)));
  }
}

/** Operation-specific submission endpoints; each maps its body to the matching CreateJobRequest. */
@Controller()
export class JobOperationsController {
  constructor(private readonly jobs: JobsService) {}

  @ApiRoute('createQuotes')
  quotes(@ApiInput() input: RouteInput<'createQuotes'>, @Headers() headers: RequestHeaders) {
    return ok(this.jobs.submit({ type: 'quote', ...input.body }, idem('createQuotes', headers)));
  }

  @ApiRoute('createProviderChecks')
  providerChecks(@ApiInput() input: RouteInput<'createProviderChecks'>, @Headers() headers: RequestHeaders) {
    return ok(this.jobs.submit({ type: 'provider_check', ...input.body }, idem('createProviderChecks', headers)));
  }

  @ApiRoute('createTransfers')
  transfers(@ApiInput() input: RouteInput<'createTransfers'>, @Headers() headers: RequestHeaders) {
    return ok(this.jobs.submit({ type: 'transfer', ...input.body }, idem('createTransfers', headers)));
  }

  @ApiRoute('createAftermarket')
  aftermarket(@ApiInput() input: RouteInput<'createAftermarket'>, @Headers() headers: RequestHeaders) {
    return ok(this.jobs.submit({ type: 'aftermarket', ...input.body }, idem('createAftermarket', headers)));
  }

  @ApiRoute('createNameChecks')
  nameChecks(@ApiInput() input: RouteInput<'createNameChecks'>, @Headers() headers: RequestHeaders) {
    return ok(this.jobs.submit({ type: 'name_check', ...input.body }, idem('createNameChecks', headers)));
  }

  @ApiRoute('createDiagnostics')
  diagnostics(@ApiInput() input: RouteInput<'createDiagnostics'>, @Headers() headers: RequestHeaders) {
    return ok(this.jobs.submit({ type: 'diagnostics', ...input.body }, idem('createDiagnostics', headers)));
  }
}
