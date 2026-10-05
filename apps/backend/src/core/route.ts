import {
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
  SetMetadata,
  applyDecorators,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { routes, type OperationId, type Routes } from '@domain-scout/contracts';
import type { z } from 'zod';
import { AppError, zodDetails } from './errors.js';

export const ROUTE_OPERATION = 'domain-scout:operation';

/**
 * Binds a controller method to a contract operation: HTTP method, path and success status come from
 * `routes` in @domain-scout/contracts, so the server cannot drift from the published OpenAPI document.
 * Controllers must be mounted at the root (`@Controller()`); the global prefix adds /api/v1.
 */
export function ApiRoute(operationId: OperationId) {
  const def = routes[operationId];
  const method = { get: Get, post: Post, put: Put, patch: Patch, delete: Delete }[def.method];
  const status = 'status' in def ? def.status : 200;
  return applyDecorators(method(def.path), HttpCode(status), SetMetadata(ROUTE_OPERATION, operationId));
}

type Out<T> = T extends z.ZodType ? z.output<T> : undefined;

/** Validated request parts for an operation. */
export type RouteInput<Op extends OperationId> = {
  params: Routes[Op] extends { params: infer P } ? Out<P> : undefined;
  query: Routes[Op] extends { query: infer Q } ? Out<Q> : undefined;
  body: Routes[Op] extends { body: infer B } ? Out<B> : undefined;
};

function parsePart(schema: z.ZodType | undefined, value: unknown, part: string) {
  if (!schema) return undefined;
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw AppError.invalid(`Invalid ${part}`, zodDetails(result.error).map((d) => ({ ...d, path: `${part}.${d.path}` })));
  }
  return result.data;
}

/** Param decorator returning `{ params, query, body }` validated against the operation's schemas. */
export const ApiInput = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const operationId = Reflect.getMetadata(ROUTE_OPERATION, ctx.getHandler()) as OperationId | undefined;
  if (!operationId) throw new Error('@ApiInput() requires @ApiRoute() on the same handler');
  const def = routes[operationId] as Routes[OperationId] & { params?: z.ZodType; query?: z.ZodType; body?: z.ZodType };
  const request = ctx.switchToHttp().getRequest<Request>();
  return {
    params: parsePart(def.params, request.params, 'params'),
    query: parsePart(def.query, request.query, 'query'),
    body: def.body ? parsePart(def.body, request.body, 'body') : undefined,
  };
});
