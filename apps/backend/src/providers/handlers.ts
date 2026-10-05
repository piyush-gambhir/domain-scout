import { Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getPublicSuffix } from 'tldts';
import { RESOLVED_ITEM_OUTCOMES, type AftermarketListing, type CapabilityName, type JobOperation } from '@domain-scout/contracts';
import { InputPreviewer } from '../core/ports.js';
import { OperationRegistry } from '../jobs/operation-registry.js';
import type { EvidenceWrite, JobItemRecord, OperationContext, OperationHandler, OperationResult } from '../jobs/operation.js';
import { CatalogService } from './catalog.service.js';
import { ProviderError, type AdapterContext, type CheckResult, type DomainParts, type OfferDraft, type ProviderAdapter } from './adapters/types.js';
import type { ProviderManifest } from './manifest.js';
import { ProvidersService, describeFailure, missingCredentialsMessage } from './providers.service.js';
import { LINK_ONLY_MARKETPLACES } from './marketplaces.js';
import { confirmationRecord, offerRecord, scrubDraft } from './records.js';

const CAPABILITY_BY_OPERATION: Partial<Record<JobOperation, CapabilityName>> = {
  provider_check: 'exactCheck',
  quote: 'quote',
  transfer: 'transfer',
  aftermarket: 'aftermarket',
};

const LISTING_CAVEAT = 'Listing evidence is not proof of seller authority, checkout availability or final acquisition cost.';

/** An offer counts only when it states the amount its purchase path is about. */
function hasPrice(draft: OfferDraft): boolean {
  if (draft.purchasePath === 'transfer') return draft.transfer.amount !== null;
  if (draft.purchasePath === 'renewal') return draft.renewal.amount !== null;
  return draft.registration.amount !== null || draft.premium.registration !== null;
}

function finish(operation: JobOperation, outcome: string, extra: Partial<OperationResult> = {}): OperationResult {
  return {
    outcome,
    resolved: RESOLVED_ITEM_OUTCOMES[operation].includes(outcome),
    evidence: [],
    error: null,
    retryable: false,
    ...extra,
  };
}

/**
 * Shared logic for the provider handlers. Each item is one domain at one provider (target). The
 * candidate name goes only to that provider's API host, recorded as the destination.
 */
abstract class ProviderOperation implements OperationHandler {
  abstract readonly operation: JobOperation;

  constructor(
    protected readonly providers: ProvidersService,
    protected readonly previewer: InputPreviewer | null,
  ) {}

  sourceKey(item: JobItemRecord): string | null {
    return `provider:${item.target}`;
  }

  destination(item: JobItemRecord): string | null {
    return this.providers.manifest(item.target)?.apiHost ?? null;
  }

  protected parts(item: JobItemRecord): DomainParts {
    const ascii = item.subject.toLowerCase();
    const suffix = item.suffix ?? this.previewer?.normalize(ascii)?.suffix ?? getPublicSuffix(ascii, { allowPrivateDomains: false }) ?? ascii.split('.').slice(1).join('.');
    const label = ascii.endsWith(`.${suffix}`) ? ascii.slice(0, -(suffix.length + 1)) : ascii.split('.')[0]!;
    return { ascii, label, suffix };
  }

  async execute(item: JobItemRecord, ctx: OperationContext): Promise<OperationResult> {
    const manifest = this.providers.manifest(item.target);
    if (!manifest) {
      return finish(this.operation, 'unsupported', { error: { code: 'unknown_provider', message: `Unknown provider ${item.target}`, retryable: false } });
    }
    const capability = manifest.capabilities[CAPABILITY_BY_OPERATION[this.operation]!];
    const adapter = this.providers.adapters.get(manifest.id);
    if (capability.level === 'unsupported' || !adapter || !this.supported(adapter)) {
      return finish(this.operation, 'unsupported', {
        error: { code: 'unsupported', message: `${manifest.name}: ${capability.notes ?? 'capability not supported'}`, retryable: false },
      });
    }
    const credentials = this.providers.resolveCredentials(manifest);
    if (capability.requiresCredentials && !credentials.configured) {
      return finish(this.operation, 'credential_required', {
        error: { code: 'credential_required', message: missingCredentialsMessage(manifest), retryable: false },
      });
    }
    const actx = this.providers.context(manifest, ctx.signal, credentials);
    try {
      return await this.run(manifest, adapter, actx, this.parts(item), ctx);
    } catch (error) {
      return this.failure(manifest, actx, error);
    }
  }

  protected abstract supported(adapter: ProviderAdapter): boolean;

  protected abstract run(
    manifest: ProviderManifest,
    adapter: ProviderAdapter,
    actx: AdapterContext,
    domain: DomainParts,
    ctx: OperationContext,
  ): Promise<OperationResult>;

  /** Maps adapter failures to item outcomes; one provider's failure never touches other evidence. */
  protected failure(manifest: ProviderManifest, actx: AdapterContext, error: unknown): OperationResult {
    const message = actx.http.scrub(describeFailure(manifest, error));
    if (!(error instanceof ProviderError)) {
      return finish(this.operation, 'error', { error: { code: 'internal', message, retryable: false } });
    }
    switch (error.kind) {
      case 'auth':
        this.providers.markCredentialsInvalid(manifest.id, message);
        return finish(this.operation, 'credentials_invalid', { error: { code: 'credentials_invalid', message, retryable: false } });
      case 'rate_limited':
        return finish(this.operation, 'rate_limited', {
          error: { code: 'rate_limited', message, retryable: true },
          retryable: true,
          cooldownUntil: error.extras.retryAt ?? null,
          retryAt: error.extras.retryAt ?? null,
        });
      case 'transient':
        return finish(this.operation, 'error', { error: { code: 'provider_unavailable', message, retryable: true }, retryable: true });
      case 'unsupported':
        return finish(this.operation, 'unsupported', { error: { code: 'unsupported', message, retryable: false } });
      case 'bad_response':
        return finish(this.operation, 'error', { error: { code: 'bad_response', message, retryable: false } });
      default:
        return finish(this.operation, 'error', { error: { code: 'rejected', message, retryable: false } });
    }
  }

  /** Provider-supplied text can echo request parameters; scrub secrets before it becomes evidence. */
  protected scrubbed(actx: AdapterContext, check: CheckResult): CheckResult {
    return { ...check, reason: { code: actx.http.scrub(check.reason.code), message: actx.http.scrub(check.reason.message) } };
  }

  protected confirmation(manifest: ProviderManifest, domain: DomainParts, check: CheckResult, ctx: OperationContext): EvidenceWrite {
    const checkedAt = ctx.now().toISOString();
    const staleAt = new Date(ctx.now().getTime() + ctx.settings.freshness.quoteMinutes * 60_000).toISOString();
    const { write } = confirmationRecord({
      providerId: manifest.id,
      domain: domain.ascii,
      suffix: domain.suffix,
      check,
      checkedAt,
      staleAt,
      destination: manifest.apiHost ?? manifest.id,
    });
    return { kind: 'observation', row: write };
  }

  /**
   * Published prices stay suffix-level (domain null); exact quotes belong to the domain. Provider
   * text is scrubbed of secrets and the offer validated before it becomes evidence.
   */
  protected offer(manifest: ProviderManifest, actx: AdapterContext, domain: DomainParts, raw: OfferDraft, ctx: OperationContext): EvidenceWrite {
    const draft = scrubDraft(raw, (text) => actx.http.scrub(text));
    const now = ctx.now();
    const exact = draft.kind !== 'published';
    const staleAt = new Date(
      now.getTime() + (exact ? ctx.settings.freshness.quoteMinutes * 60_000 : ctx.settings.freshness.catalogHours * 3_600_000),
    ).toISOString();
    const link = this.providers.destination(manifest.id, domain.ascii, draft.purchasePath);
    const destination = draft.destination ?? (exact && link ? { url: link.url, kind: link.kind } : null);
    const { write } = offerRecord({
      providerId: manifest.id,
      domain: exact ? domain.ascii : null,
      suffix: domain.suffix,
      draft,
      observedAt: now.toISOString(),
      staleAt,
      destination,
    });
    return { kind: 'offer', row: write };
  }
}

@Injectable()
export class ProviderCheckHandler extends ProviderOperation {
  readonly operation = 'provider_check' as const;

  constructor(providers: ProvidersService, @Optional() previewer?: InputPreviewer) {
    super(providers, previewer ?? null);
  }

  protected supported(adapter: ProviderAdapter) {
    return Boolean(adapter.check);
  }

  protected async run(manifest: ProviderManifest, adapter: ProviderAdapter, actx: AdapterContext, domain: DomainParts, ctx: OperationContext) {
    const check = this.scrubbed(actx, await adapter.check!(actx, domain));
    this.providers.clearCredentialFailure(manifest.id);
    return finish(this.operation, check.status, { evidence: [this.confirmation(manifest, domain, check, ctx)] });
  }
}

@Injectable()
export class QuoteHandler extends ProviderOperation {
  readonly operation = 'quote' as const;

  constructor(providers: ProvidersService, @Optional() previewer?: InputPreviewer) {
    super(providers, previewer ?? null);
  }

  protected supported(adapter: ProviderAdapter) {
    return Boolean(adapter.quote);
  }

  protected async run(manifest: ProviderManifest, adapter: ProviderAdapter, actx: AdapterContext, domain: DomainParts, ctx: OperationContext) {
    const result = await adapter.quote!(actx, domain);
    this.providers.clearCredentialFailure(manifest.id);
    const check = result.check ? this.scrubbed(actx, result.check) : null;
    const offers = result.offers.filter(hasPrice);
    const evidence: EvidenceWrite[] = [];
    // The quote response also states availability: keep it as its own confirmation evidence.
    if (check && check.status !== 'unknown') evidence.push(this.confirmation(manifest, domain, check, ctx));
    for (const draft of offers) evidence.push(this.offer(manifest, actx, domain, draft, ctx));
    const status = check?.status ?? 'unknown';
    const outcome = offers.length ? 'quoted' : status === 'available' ? 'no_price' : status;
    const error =
      outcome === 'no_price'
        ? { code: 'no_price', message: `${manifest.name} reported the name available but returned no price for it`, retryable: false }
        : null;
    return finish(this.operation, outcome, { evidence, error });
  }
}

@Injectable()
export class TransferHandler extends ProviderOperation {
  readonly operation = 'transfer' as const;

  constructor(providers: ProvidersService, @Optional() previewer?: InputPreviewer) {
    super(providers, previewer ?? null);
  }

  protected supported(adapter: ProviderAdapter) {
    return Boolean(adapter.transfer);
  }

  protected async run(manifest: ProviderManifest, adapter: ProviderAdapter, actx: AdapterContext, domain: DomainParts, ctx: OperationContext) {
    const result = await adapter.transfer!(actx, domain);
    this.providers.clearCredentialFailure(manifest.id);
    const offers = result.offers.filter(hasPrice);
    if (!offers.length) {
      const outcome = result.reason.code === 'not_transferable' ? 'not_transferable' : 'no_price';
      return finish(this.operation, outcome, { error: { code: outcome, message: actx.http.scrub(result.reason.message), retryable: false } });
    }
    return finish(this.operation, 'quoted', { evidence: offers.map((d) => this.offer(manifest, actx, domain, d, ctx)) });
  }
}

@Injectable()
export class AftermarketHandler extends ProviderOperation {
  readonly operation = 'aftermarket' as const;

  constructor(providers: ProvidersService, @Optional() previewer?: InputPreviewer) {
    super(providers, previewer ?? null);
  }

  override sourceKey(item: JobItemRecord): string | null {
    return this.providers.manifest(item.target) ? `provider:${item.target}` : null;
  }

  override destination(item: JobItemRecord): string | null {
    return this.providers.manifest(item.target)?.apiHost ?? null;
  }

  override async execute(item: JobItemRecord, ctx: OperationContext): Promise<OperationResult> {
    const marketplace = LINK_ONLY_MARKETPLACES[item.target];
    if (marketplace) {
      return finish(this.operation, 'unsupported', { error: { code: 'unsupported', message: `${marketplace.name}: ${marketplace.reason}`, retryable: false } });
    }
    return super.execute(item, ctx);
  }

  protected supported(adapter: ProviderAdapter) {
    return Boolean(adapter.aftermarket);
  }

  protected async run(manifest: ProviderManifest, adapter: ProviderAdapter, actx: AdapterContext, domain: DomainParts, ctx: OperationContext) {
    const listing = await adapter.aftermarket!(actx, domain);
    this.providers.clearCredentialFailure(manifest.id);
    const observedAt = ctx.now().toISOString();
    const staleAt = new Date(ctx.now().getTime() + ctx.settings.freshness.quoteMinutes * 60_000).toISOString();
    const id = randomUUID();
    const payload: Omit<AftermarketListing, 'freshness'> = {
      id,
      domain: domain.ascii,
      marketplace: actx.http.scrub(listing.marketplace),
      providerId: manifest.id,
      status: listing.status,
      price: listing.price,
      url: listing.url === null ? null : actx.http.scrub(listing.url),
      observedAt,
      source: `${manifest.name} (${actx.http.scrub(listing.reason.message)})`,
      caveat: LISTING_CAVEAT,
    };
    const outcome = listing.status === 'not_listed' ? 'not_listed' : listing.status === 'unknown' ? 'unknown' : 'listed';
    return finish(this.operation, outcome, {
      evidence: [
        {
          kind: 'observation',
          row: {
            id,
            kind: 'listing',
            subject: domain.ascii,
            suffix: domain.suffix,
            sourceId: manifest.id,
            destination: manifest.apiHost,
            outcome: listing.status,
            observedAt,
            staleAt,
            payload: payload as unknown as Record<string, unknown>,
          },
        },
      ],
    });
  }
}

/** catalog_refresh items: subject is the provider id; no candidate name leaves the machine. */
@Injectable()
export class CatalogHandler implements OperationHandler {
  readonly operation = 'catalog' as const;

  constructor(
    private readonly providers: ProvidersService,
    private readonly catalogs: CatalogService,
  ) {}

  private providerId(item: JobItemRecord) {
    return item.target || item.subject;
  }

  sourceKey(item: JobItemRecord): string | null {
    return `provider:${this.providerId(item)}`;
  }

  destination(item: JobItemRecord): string | null {
    const manifest = this.providers.manifest(this.providerId(item));
    return manifest ? (manifest.catalogHost ?? manifest.apiHost) : null;
  }

  /** Full price lists are large (Porkbun's took about 10 s live); allow two minutes. */
  timeoutMs(): number {
    return 120_000;
  }

  async execute(item: JobItemRecord, ctx: OperationContext): Promise<OperationResult> {
    if (!this.providers.manifest(this.providerId(item))) {
      return finish('catalog', 'unsupported', { error: { code: 'unknown_provider', message: `Unknown provider ${this.providerId(item)}`, retryable: false } });
    }
    const result = await this.catalogs.refresh(this.providerId(item), ctx.signal);
    const retryable = result.error?.retryable ?? false;
    return finish('catalog', result.outcome, {
      // The catalog service writes the offers with its fetch; linking them lets watches detect price changes.
      ...(result.offerIds.length ? { reused: { offerIds: result.offerIds } } : {}),
      error: result.error,
      retryable,
      cooldownUntil: result.outcome === 'rate_limited' ? result.retryAt : null,
      retryAt: result.retryAt,
    });
  }
}

/** Registers every provider handler with the jobs engine. */
@Injectable()
export class ProviderHandlersRegistrar implements OnModuleInit {
  constructor(
    private readonly registry: OperationRegistry,
    private readonly check: ProviderCheckHandler,
    private readonly quote: QuoteHandler,
    private readonly transfer: TransferHandler,
    private readonly aftermarket: AftermarketHandler,
    private readonly catalog: CatalogHandler,
  ) {}

  onModuleInit() {
    for (const handler of [this.check, this.quote, this.transfer, this.aftermarket, this.catalog]) this.registry.register(handler);
  }
}
