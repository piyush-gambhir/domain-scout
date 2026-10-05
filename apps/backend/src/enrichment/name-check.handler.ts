import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  RESOLVED_ITEM_OUTCOMES,
  type NameCheck,
  type NameCheckOutcome,
  type NameCheckServiceId,
} from '@domain-scout/contracts';
import type { JobItemRecord, OperationContext, OperationHandler, OperationResult } from '../jobs/operation.js';
import { SERVICES, type SupportedService } from './name-check.services.js';
import { classifyError, discardBody, readBounded, retryAfter, throwIfJobAborted, withTimeout } from './net.js';
import { ENRICHMENT_FETCH, USER_AGENT, type FetchLike } from './transports.js';

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

interface Observed {
  outcome: NameCheckOutcome;
  httpStatus: number | null;
  reason: { code: string; message: string };
  detail: Record<string, unknown> | null;
  retryable?: boolean;
  cooldownUntil?: string | null;
}

/**
 * `name_check` items: subject is the name, target is the service id. Only the selected service is
 * contacted; unsupported services and invalid names produce evidence without any request.
 */
@Injectable()
export class NameCheckHandler implements OperationHandler {
  readonly operation = 'name_check' as const;

  constructor(@Inject(ENRICHMENT_FETCH) private readonly fetch: FetchLike) {}

  sourceKey(item: JobItemRecord): string | null {
    const spec = SERVICES[item.target as NameCheckServiceId];
    return spec?.supported ? `service:${spec.id}` : null;
  }

  destination(item: JobItemRecord): string | null {
    const spec = SERVICES[item.target as NameCheckServiceId];
    return spec?.supported ? spec.host : null;
  }

  async execute(item: JobItemRecord, ctx: OperationContext): Promise<OperationResult> {
    const checkedAt = ctx.now();
    const spec = SERVICES[item.target as NameCheckServiceId];
    if (!spec) {
      return this.result(item, ctx, checkedAt, null, {
        outcome: 'unsupported',
        httpStatus: null,
        reason: { code: 'unknown_service', message: `Unknown name-check service ${item.target}` },
        detail: null,
      });
    }
    if (!spec.supported) {
      return this.result(item, ctx, checkedAt, null, {
        outcome: 'unsupported',
        httpStatus: null,
        reason: { code: 'unsupported_service', message: spec.reason },
        detail: null,
      });
    }
    const invalid = spec.validate(item.subject);
    if (invalid) {
      return this.result(item, ctx, checkedAt, spec, {
        outcome: 'error',
        httpStatus: null,
        reason: { code: 'invalid_name', message: invalid },
        detail: null,
      });
    }
    return this.result(item, ctx, checkedAt, spec, await this.query(spec, item.subject, ctx, checkedAt));
  }

  private async query(spec: SupportedService, name: string, ctx: OperationContext, now: Date): Promise<Observed> {
    const timer = withTimeout(ctx.signal, ctx.settings.retries.timeoutMs);
    let url = spec.url(name);
    let followedCanonical = false;
    let response: Response;
    for (;;) {
      try {
        // Redirects are not followed automatically: the name must only reach the declared service host.
        response = await this.fetch(url, {
          method: 'GET',
          redirect: 'manual',
          headers: { accept: spec.accept, 'user-agent': USER_AGENT },
          signal: timer.signal,
        });
      } catch (error) {
        throwIfJobAborted(ctx.signal);
        const failure = classifyError(error, timer.timedOut());
        return {
          outcome: 'error',
          httpStatus: null,
          reason: { code: failure.code, message: `${spec.name} request failed: ${failure.message}` },
          detail: null,
          retryable: failure.kind !== 'unreachable',
        };
      }
      if (response.status < 300 || response.status >= 400) break;
      await discardBody(response);
      const location = parseLocation(response.headers.get('location'), url);
      // At most one same-host canonical-name redirect (PyPI display names) is followed; the
      // target's body is then verified like any other response.
      if (!followedCanonical && location && spec.canonicalRedirect?.(location, name)) {
        followedCanonical = true;
        url = location.toString();
        continue;
      }
      return {
        outcome: 'error',
        httpStatus: response.status,
        reason: {
          code: 'unexpected_redirect',
          message: `${spec.name} redirected to ${location?.host ?? 'an unknown location'}; the redirect was not followed`,
        },
        detail: null,
        retryable: false,
      };
    }

    const status = response.status;
    if (status === 404) {
      await discardBody(response);
      return {
        outcome: 'not_found',
        httpStatus: status,
        reason: {
          code: 'not_found',
          message: `${spec.name} returned no public record for this ${spec.namespace}. This does not mean the name can be claimed: it may be reserved, restricted or held privately.`,
        },
        detail: null,
      };
    }
    if (status === 429 || (status === 403 && spec.id === 'github')) {
      await discardBody(response);
      const cooldownUntil =
        retryAfter(response.headers.get('retry-after'), now) ??
        epochSeconds(response.headers.get('x-ratelimit-reset')) ??
        new Date(now.getTime() + DEFAULT_RATE_LIMIT_WAIT_MS).toISOString();
      return {
        outcome: 'rate_limited',
        httpStatus: status,
        reason: { code: 'rate_limited', message: `${spec.name} rate limited the request; retry after ${cooldownUntil}` },
        detail: null,
        retryable: true,
        cooldownUntil,
      };
    }
    if (status !== 200) {
      await discardBody(response);
      return {
        outcome: 'error',
        httpStatus: status,
        reason: { code: 'http_error', message: `${spec.name} returned HTTP ${status}` },
        detail: null,
        retryable: status >= 500,
      };
    }

    let body;
    try {
      body = await readBounded(response, MAX_BODY_BYTES);
    } catch (error) {
      throwIfJobAborted(ctx.signal);
      const failure = classifyError(error, timer.timedOut());
      return {
        outcome: 'error',
        httpStatus: status,
        reason: { code: failure.code, message: `${spec.name} response could not be read: ${failure.message}` },
        detail: null,
        retryable: true,
      };
    }
    const json = parseObject(body.text);
    // A 200 only counts as existence when the body names the requested record. Maintenance pages,
    // empty bodies and truncated bodies without the identity field stay unresolved.
    const returned = spec.returnedName(json) ?? (json === null && body.truncated ? spec.textName(body.text) : null);
    if (returned === null) {
      return {
        outcome: 'error',
        httpStatus: status,
        reason: {
          code: 'unverifiable_response',
          message: `${spec.name} answered HTTP 200 without identifying the ${spec.namespace}${body.truncated ? ' in the first part of a truncated body' : ''}`,
        },
        detail: null,
        retryable: true,
      };
    }
    if (!spec.same(returned, name)) {
      return {
        outcome: 'error',
        httpStatus: status,
        reason: { code: 'response_mismatch', message: `${spec.name} returned a record for ${returned}, not ${name}` },
        detail: null,
      };
    }
    const detail = spec.detail(json, body.text);
    if (body.truncated) detail.truncated = true;
    return {
      outcome: 'exists',
      httpStatus: status,
      reason: { code: 'exists', message: `${spec.name} has a public ${spec.namespace} with this name` },
      detail,
    };
  }

  private result(
    item: JobItemRecord,
    ctx: OperationContext,
    checkedAt: Date,
    spec: SupportedService | null,
    observed: Observed,
  ): OperationResult {
    const serviceId = (SERVICES[item.target as NameCheckServiceId]?.id ?? item.target) as NameCheckServiceId;
    const namespace = SERVICES[serviceId]?.namespace ?? item.target;
    // Freshness is computed at read time; staleAt follows the registry freshness setting.
    const staleAt = new Date(checkedAt.getTime() + ctx.settings.freshness.registryMinutes * 60_000).toISOString();
    const check: Omit<NameCheck, 'freshness'> = {
      id: randomUUID(),
      name: item.subject,
      service: serviceId,
      namespace,
      outcome: observed.outcome,
      destination: spec?.host ?? null,
      httpStatus: observed.httpStatus,
      checkedAt: checkedAt.toISOString(),
      staleAt,
      reason: observed.reason,
      detail: observed.detail,
    };
    const resolved = RESOLVED_ITEM_OUTCOMES.name_check.includes(observed.outcome);
    return {
      outcome: observed.outcome,
      resolved,
      evidence: [
        {
          kind: 'observation',
          row: {
            id: check.id,
            kind: 'name_check',
            subject: item.subject,
            suffix: null,
            sourceId: `service:${serviceId}`,
            destination: check.destination,
            outcome: check.outcome,
            observedAt: check.checkedAt,
            staleAt,
            payload: check as unknown as Record<string, unknown>,
          },
        },
      ],
      error: resolved ? null : { code: observed.reason.code, message: observed.reason.message, retryable: observed.retryable ?? false },
      retryable: observed.retryable ?? false,
      cooldownUntil: observed.cooldownUntil ?? null,
      retryAt: observed.cooldownUntil ?? null,
    };
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseLocation(location: string | null, base: string): URL | null {
  if (!location) return null;
  try {
    return new URL(location, base);
  } catch {
    return null;
  }
}

function epochSeconds(header: string | null): string | null {
  const seconds = Number(header);
  return header && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}
