import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  API_PREFIX,
  CONTRACT_VERSION,
  type ExportScope,
  type SnapshotArtifact,
  type SnapshotCreate,
} from '@domain-scout/contracts';
import type { z } from 'zod';
import { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { json } from '../storage/database.js';
import { ArtifactStore, fileStamp, type ArtifactRow } from './artifact-store.service.js';
import { UNCERTAINTY_NOTICE } from './rows.js';
import { ScopeResolver, type ScopedRecord } from './scope-resolver.service.js';
import { renderSnapshotHtml, type SnapshotDocument, type SnapshotItem } from './snapshot-render.js';

type SnapshotInput = z.output<typeof SnapshotCreate>;
type Include = SnapshotInput['include'];

interface SnapshotOptions {
  include: Include;
  jsonFile: string;
  downloadBase: string;
  resolved: unknown;
}

/**
 * Local share snapshots: a self-contained HTML report plus the same data as JSON. Contents come only
 * from retained evidence; private notes are left out unless include.notes is set. Raw diagnostics,
 * offer source URLs and anything credential-related are never included.
 */
@Injectable()
export class SnapshotsService {
  constructor(
    private readonly clock: Clock,
    private readonly store: ArtifactStore,
    private readonly resolver: ScopeResolver,
  ) {}

  preview(body: SnapshotInput) {
    const doc = this.build(body, 'preview', this.clock.iso());
    return {
      itemCount: doc.items.length,
      fields: fieldsOf(body.include),
      includesNotes: body.include.notes,
      sample: doc.items.slice(0, 5) as unknown as Record<string, unknown>[],
    };
  }

  create(body: SnapshotInput): SnapshotArtifact {
    const id = randomUUID();
    const createdAt = this.clock.iso();
    const doc = this.build(body, id, createdAt);
    const htmlFile = `${id}.html`;
    const jsonFile = `${id}.json`;
    const size = this.store.write(htmlFile, renderSnapshotHtml(doc)) + this.store.write(jsonFile, `${JSON.stringify(doc, null, 2)}\n`);
    const options: SnapshotOptions = {
      include: body.include,
      jsonFile,
      downloadBase: `domain-scout-snapshot-${fileStamp(createdAt)}`,
      resolved: doc.resolved,
    };
    this.store.insert({
      id,
      kind: 'snapshot',
      title: body.title,
      format: 'html',
      scope: body.scope,
      options,
      itemCount: doc.items.length,
      fileName: htmlFile,
      sizeBytes: size,
      warnings: [],
      createdAt,
    });
    return this.get(id);
  }

  list(): SnapshotArtifact[] {
    return this.store.list('snapshot').map(toArtifact);
  }

  get(id: string): SnapshotArtifact {
    return toArtifact(this.store.get('snapshot', id));
  }

  download(id: string, format: 'html' | 'json') {
    const row = this.store.get('snapshot', id);
    const options = json.parse<Partial<SnapshotOptions>>(row.options_json, {});
    const file = format === 'json' ? (options.jsonFile ?? `${row.id}.json`) : row.file_name;
    return {
      body: this.store.read(file),
      contentType: format === 'json' ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
      fileName: `${options.downloadBase ?? `snapshot-${row.id}`}.${format}`,
    };
  }

  delete(id: string) {
    const row = this.store.get('snapshot', id);
    const options = json.parse<Partial<SnapshotOptions>>(row.options_json, {});
    this.store.delete('snapshot', id, [row.file_name, options.jsonFile ?? `${row.id}.json`]);
  }

  private build(body: SnapshotInput, id: string, createdAt: string): SnapshotDocument {
    const resolution = this.resolver.resolve(body.scope);
    const byDomain = new Map<string, SnapshotItem>();
    for (const record of resolution.records) {
      // A job can hold several items per domain (one per provider); a report shows each name once.
      const existing = byDomain.get(record.domain);
      if (existing) merge(existing, this.item(record, body));
      else byDomain.set(record.domain, this.item(record, body));
    }
    const items = [...byDomain.values()];
    if (items.length > 50_000) throw AppError.invalid('Snapshots are limited to 50,000 names; narrow the scope');
    return {
      contractVersion: CONTRACT_VERSION,
      kind: 'domain-scout-snapshot',
      id,
      title: body.title,
      createdAt,
      scope: body.scope,
      scopeLabel: resolution.label,
      resolved: resolution.resolved,
      include: body.include,
      notice: UNCERTAINTY_NOTICE,
      items,
    };
  }

  private item(record: ScopedRecord, body: SnapshotInput): SnapshotItem {
    const include = body.include;
    const item: SnapshotItem = { domain: record.domain, unicode: record.unicode, suffix: record.suffix };
    const registry = record.registry;
    if (include.evidence) {
      item.registry = registry
        ? {
            outcome: registry.outcome,
            checkedAt: registry.checkedAt,
            freshnessAtCreation: registry.freshness,
            source: registry.source?.destination ?? null,
            protocol: registry.source?.protocol ?? null,
            reason: registry.reason?.message ?? null,
            eligibility: registry.eligibility?.status ?? null,
          }
        : null;
      item.confirmations = record.confirmations.map((c) => ({
        providerId: c.providerId,
        status: c.status,
        checkedAt: c.checkedAt,
        freshnessAtCreation: c.freshness,
      }));
      if (record.other.length) {
        item.checks = record.other.map((o) => ({
          kind: o.kind,
          label: o.label,
          outcome: o.outcome,
          checkedAt: o.checkedAt,
          freshnessAtCreation: o.freshness,
          source: o.source,
          reason: o.reason,
        }));
      }
    }
    if (include.registration) {
      const details = registry?.registration ?? null;
      item.registration = details
        ? {
            registrar: details.registrar,
            createdAt: details.createdAt,
            expiresAt: details.expiresAt,
            statuses: details.statuses ?? [],
            nameservers: details.nameservers ?? [],
          }
        : null;
    }
    if (include.prices) {
      item.prices = record.offers.map((offer) => ({
        providerId: offer.providerId,
        kind: offer.kind,
        purchasePath: offer.purchasePath,
        currency: offer.currency,
        region: offer.region,
        years: offer.registration?.years ?? null,
        registration: offer.registration?.amount ?? null,
        renewal: offer.renewal?.amount ?? null,
        observedAt: offer.observedAt,
        freshnessAtCreation: offer.freshness,
        // Only the label: source URLs can carry query parameters and are not needed in a report.
        source: offer.source?.label ?? null,
      }));
      if (!item.prices.length && record.bestPrice) {
        item.prices.push({
          providerId: record.bestPrice.providerId,
          kind: record.bestPrice.kind,
          purchasePath: 'new_registration',
          currency: record.bestPrice.currency,
          region: null,
          years: record.bestPrice.years,
          registration: record.bestPrice.amount,
          renewal: null,
          observedAt: null,
          freshnessAtCreation: null,
          source: null,
        });
      }
    }
    if (include.notes) {
      item.notes = body.scope.kind === 'collection' ? record.notes : this.resolver.notesFor(record.domain);
    }
    return item;
  }
}

function merge(target: SnapshotItem, extra: SnapshotItem) {
  if (target.registry === null && extra.registry) target.registry = extra.registry;
  if (target.confirmations && extra.confirmations) target.confirmations.push(...extra.confirmations);
  if (extra.checks?.length) target.checks = [...(target.checks ?? []), ...extra.checks];
  if (target.registration === null && extra.registration) target.registration = extra.registration;
  if (target.prices && extra.prices) {
    const keys = new Set(target.prices.map((p) => JSON.stringify(p)));
    for (const price of extra.prices) if (!keys.has(JSON.stringify(price))) target.prices.push(price);
  }
}

function fieldsOf(include: Include): string[] {
  return [
    'domain',
    'unicode',
    'suffix',
    ...(include.evidence ? ['registry', 'confirmations'] : []),
    ...(include.registration ? ['registration'] : []),
    ...(include.prices ? ['prices'] : []),
    ...(include.notes ? ['notes'] : []),
  ];
}

function toArtifact(row: ArtifactRow): SnapshotArtifact {
  const options = json.parse<Partial<SnapshotOptions>>(row.options_json, {});
  const include = options.include ?? { evidence: true, prices: true, registration: true, notes: false };
  return {
    id: row.id,
    title: row.title ?? '',
    scope: json.parse<ExportScope>(row.scope_json, { kind: 'all' }),
    include,
    itemCount: row.item_count,
    createdAt: row.created_at,
    htmlPath: `${API_PREFIX}/snapshots/${row.id}/download?format=html`,
    jsonPath: `${API_PREFIX}/snapshots/${row.id}/download?format=json`,
    sizeBytes: row.size_bytes,
  };
}
