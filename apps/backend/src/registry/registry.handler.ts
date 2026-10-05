import { Injectable } from '@nestjs/common';
import { AsciiDomain, RESOLVED_ITEM_OUTCOMES, Suffix, type NormalizedDomain, type RegistryObservation, type Settings } from '@domain-scout/contracts';
import { randomUUID } from 'node:crypto';
import { EvidenceRepository } from '../storage/evidence.js';
import type { JobItemRecord, OperationContext, OperationHandler, OperationResult } from '../jobs/operation.js';
import { UNKNOWN_ELIGIBILITY, type Classification } from './classification.js';
import { InputPreviewService } from './input/input-preview.service.js';
import { MAX_PACING_WAIT_MS, PublishedLimits } from './published-limits.js';
import { RegistryChecker, type CheckResult } from './registry-checker.js';
import { RoutesService, type RegistryRoute } from './routes.service.js';

/** Stored payload: the contract object without fields computed at read time. */
type RegistryPayload = Omit<RegistryObservation, 'freshness' | 'reused'>;

const LOCAL_PARSER_VERSION = 'local/1';
const REUSABLE_OUTCOMES = new Set(['registered', 'no_record']);

function aborted(): OperationResult {
  return {
    outcome: 'inconclusive',
    resolved: false,
    evidence: [],
    error: { code: 'aborted', message: 'The check was cancelled before the registry answered', retryable: false },
    retryable: false,
  };
}

function publishedLimits(route: RegistryRoute) {
  const limits = route.whois?.publishedLimits ?? route.curatedRdap?.publishedLimits;
  return limits && limits.length > 0 ? limits : null;
}

export function isResolvedRegistryOutcome(outcome: string): boolean {
  return RESOLVED_ITEM_OUTCOMES.registry.includes(outcome);
}

/**
 * The `registry` operation: one domain against its routed registry. Invalid and unsupported names are
 * answered locally with no network call. Fresh registered/no_record evidence is reused when the job
 * allows cache; unresolved evidence is never reused.
 */
@Injectable()
export class RegistryOperationHandler implements OperationHandler {
  readonly operation = 'registry' as const;

  constructor(
    private readonly inputs: InputPreviewService,
    private readonly routes: RoutesService,
    private readonly checker: RegistryChecker,
    private readonly evidence: EvidenceRepository,
    private readonly limits: PublishedLimits,
  ) {}

  private resolve(item: JobItemRecord): { domain: NormalizedDomain | null; route: RegistryRoute | null } {
    const domain = this.inputs.normalize(item.subject);
    return { domain, route: domain ? this.routes.route(domain.suffix) : null };
  }

  sourceKey(item: JobItemRecord): string | null {
    const { route } = this.resolve(item);
    return route ? `registry:${route.registryId}` : null;
  }

  destination(item: JobItemRecord): string | null {
    return this.resolve(item).route?.endpoint ?? null;
  }

  /** Items routed to a registry with published limits may first wait for a slot (PublishedLimits). */
  timeoutMs(item: JobItemRecord, settings: Settings): number | undefined {
    const { route } = this.resolve(item);
    return route && publishedLimits(route) ? settings.retries.timeoutMs + MAX_PACING_WAIT_MS : undefined;
  }

  async execute(item: JobItemRecord, ctx: OperationContext): Promise<OperationResult> {
    const detailed = this.inputs.normalizeDetailed(item.subject);
    const domain = detailed.domain;
    if (!domain) {
      const unknown = detailed.reasons.find((r) => r.code === 'unknown_suffix');
      if (unknown) {
        // An unknown extension is unresolved (unsupported), not a definitive invalid answer.
        return this.local(item, null, ctx, 'unsupported', 'unknown_suffix', `${unknown.message}. DNS is not used as a substitute.`);
      }
      const why = detailed.reasons.map((r) => r.message).join('; ') || 'Not a registrable domain';
      const message = detailed.suggestion ? `${why}. Suggested: ${detailed.suggestion}` : why;
      return this.local(item, null, ctx, 'invalid', 'invalid_domain', message);
    }

    const route = this.routes.route(domain.suffix);
    if (!route) {
      return this.local(
        item,
        domain,
        ctx,
        'unsupported',
        'no_registry_route',
        `No verified registry lookup for .${domain.suffix}: ${this.routes.unsupportedReason(domain.suffix)}. DNS is not used as a substitute.`,
      );
    }

    if (ctx.allowCache) {
      const latest = this.evidence.latestObservation('registry', domain.ascii);
      if (latest && REUSABLE_OUTCOMES.has(latest.outcome) && Date.parse(latest.stale_at) > ctx.now().getTime()) {
        return { outcome: latest.outcome, resolved: isResolvedRegistryOutcome(latest.outcome), evidence: [], reused: { registryObservationId: latest.id } };
      }
    }

    const limits = publishedLimits(route);
    if (limits) {
      const slot = this.limits.reserve(route.registryId, limits, ctx.now());
      if ('retryAt' in slot) {
        // Nothing is sent: the registry's own published limit would be exceeded.
        const stated = limits.map((limit) => `${limit.queries} queries per ${limit.windowSeconds} s (${limit.source})`).join(' and ');
        const message = `Not sent to ${route.host}: the .${route.tld} registry publishes a per-IP limit of ${stated}. Next query allowed at ${slot.retryAt}.`;
        return {
          outcome: 'rate_limited',
          resolved: false,
          evidence: [],
          error: { code: 'published_rate_limit', message, retryable: true },
          retryable: true,
          cooldownUntil: slot.retryAt,
          retryAt: slot.retryAt,
        };
      }
      try {
        await this.limits.wait(slot.waitMs, ctx.signal);
      } catch {
        return aborted();
      }
    }

    const result = await this.checker.check(domain, route, { signal: ctx.signal, timeoutMs: ctx.settings.retries.timeoutMs, now: ctx.now });
    if (result.aborted) return aborted();
    return this.observed(domain, route, ctx, result);
  }

  private observed(domain: NormalizedDomain, route: RegistryRoute, ctx: OperationContext, result: CheckResult): OperationResult {
    const c = result.classification;
    const checkedAt = ctx.now().toISOString();
    const keepRaw = ctx.settings.privacy.keepRawDiagnostics && result.raw !== null;
    const payload = this.payload(domain.ascii, domain.unicode, domain.suffix, c, checkedAt, ctx, result.parserVersion, keepRaw, {
      registryId: route.registryId,
      protocol: route.protocol,
      destination: route.endpoint,
      routing: route.routing,
    });
    return {
      outcome: c.outcome,
      resolved: isResolvedRegistryOutcome(c.outcome),
      evidence: [
        {
          kind: 'observation',
          row: {
            id: payload.id,
            kind: 'registry',
            subject: domain.ascii,
            suffix: domain.suffix,
            sourceId: route.registryId,
            destination: route.endpoint,
            outcome: c.outcome,
            observedAt: checkedAt,
            staleAt: payload.staleAt,
            payload: payload as unknown as Record<string, unknown>,
            raw: keepRaw ? result.raw : null,
          },
        },
      ],
      error: isResolvedRegistryOutcome(c.outcome) ? null : { code: c.reason.code, message: c.reason.message, retryable: c.retryable },
      retryable: c.retryable,
      cooldownUntil: c.cooldownUntil,
      retryAt: c.retryAt,
    };
  }

  /** Invalid or unsupported: evidence that explains why nothing was queried. Never retried automatically. */
  private local(
    item: JobItemRecord,
    domain: NormalizedDomain | null,
    ctx: OperationContext,
    outcome: 'invalid' | 'unsupported',
    code: string,
    message: string,
  ): OperationResult {
    const checkedAt = ctx.now().toISOString();
    const ascii = domain?.ascii ?? item.subject;
    const suffix = domain?.suffix ?? item.suffix ?? item.subject.slice(item.subject.lastIndexOf('.') + 1);
    const classification: Classification = {
      outcome,
      reason: { code, message },
      httpStatus: null,
      matchedName: null,
      registration: null,
      eligibility: UNKNOWN_ELIGIBILITY,
      retryable: false,
      cooldownUntil: null,
      retryAt: null,
    };
    const error = isResolvedRegistryOutcome(outcome) ? null : { code, message, retryable: false };
    if (!AsciiDomain.safeParse(ascii).success || !Suffix.safeParse(suffix).success) {
      // The subject cannot be expressed as a RegistryObservation; report the outcome without evidence.
      return { outcome, resolved: isResolvedRegistryOutcome(outcome), evidence: [], error: error ?? { code, message, retryable: false }, retryable: false };
    }
    const payload = this.payload(ascii, domain?.unicode ?? item.unicode, suffix, classification, checkedAt, ctx, LOCAL_PARSER_VERSION, false, null);
    return {
      outcome,
      resolved: isResolvedRegistryOutcome(outcome),
      evidence: [
        {
          kind: 'observation',
          row: {
            id: payload.id,
            kind: 'registry',
            subject: ascii,
            suffix: suffix || null,
            sourceId: null,
            destination: null,
            outcome,
            observedAt: checkedAt,
            staleAt: payload.staleAt,
            payload: payload as unknown as Record<string, unknown>,
            raw: null,
          },
        },
      ],
      error,
      retryable: false,
    };
  }

  private payload(
    ascii: string,
    unicode: string,
    suffix: string,
    c: Classification,
    checkedAt: string,
    ctx: OperationContext,
    parserVersion: string,
    hasRaw: boolean,
    source: RegistryPayload['source'],
  ): RegistryPayload {
    return {
      id: randomUUID(),
      domain: ascii,
      unicode,
      suffix,
      source,
      outcome: c.outcome,
      eligibility: c.eligibility,
      reason: c.reason,
      checkedAt,
      staleAt: new Date(Date.parse(checkedAt) + ctx.settings.freshness.registryMinutes * 60_000).toISOString(),
      httpStatus: c.httpStatus,
      retryAt: c.retryAt,
      matchedName: c.matchedName,
      parserVersion,
      registration: c.registration,
      hasRawDiagnostics: hasRaw,
    };
  }
}
