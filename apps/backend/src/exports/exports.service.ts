import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  API_PREFIX,
  CONTRACT_VERSION,
  DEFAULT_EXPORT_FIELDS,
  type ExportArtifact,
  type ExportCreate,
  type ExportField,
  type ExportScope,
} from '@domain-scout/contracts';
import type { z } from 'zod';
import { Clock } from '../core/clock.js';
import { json } from '../storage/database.js';
import { ArtifactStore, fileStamp, type ArtifactRow } from './artifact-store.service.js';
import {
  REQUIRED_STRUCTURED_FIELDS,
  UNCERTAINTY_NOTICE,
  csvLine,
  fieldValue,
  isCandidate,
  pickPrice,
} from './rows.js';
import { ScopeResolver, type ResolvedScope, type ScopedRecord } from './scope-resolver.service.js';

type ExportInput = z.output<typeof ExportCreate>;
type Format = ExportInput['format'];

const CONTENT_TYPES: Record<Format, string> = {
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

interface ExportOptions {
  fields: ExportField[];
  includeNotes: boolean;
  candidatesOnly: boolean;
  downloadName: string;
  resolved: ResolvedScope;
}

/**
 * TXT, CSV and JSON exports. The scope is resolved to stable item and evidence ids and the file is
 * written when the export is created, so later job changes never alter an existing export.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly clock: Clock,
    private readonly store: ArtifactStore,
    private readonly resolver: ScopeResolver,
  ) {}

  create(body: ExportInput): ExportArtifact {
    const id = randomUUID();
    const createdAt = this.clock.iso();
    const resolution = this.resolver.resolve(body.scope);
    const warnings = [...resolution.warnings];
    let records = resolution.records;

    if (body.includeNotes) {
      for (const record of records) {
        if (body.scope.kind !== 'collection') record.notes = this.resolver.notesFor(record.domain);
      }
    } else {
      for (const record of records) record.notes = null;
    }

    let fields: ExportField[];
    let content: string;
    let itemCount = records.length;
    // TXT is a plain candidate list: it keeps candidates only unless the request opts out explicitly.
    const candidatesOnly = body.format === 'txt' && body.candidatesOnly !== false;
    if (body.format === 'txt') {
      fields = ['domain'];
      if (body.fields?.length) warnings.push('TXT exports contain names only; chosen fields are ignored');
      if (candidatesOnly) records = records.filter(isCandidate);
      const names = [...new Set(records.map((r) => r.domain))];
      content = txt(names, { createdAt, label: resolution.label, candidatesOnly });
      itemCount = names.length;
    } else {
      if (body.candidatesOnly) warnings.push('candidatesOnly applies to TXT exports only and was ignored');
      fields = this.fields(body, warnings);
      content =
        body.format === 'csv'
          ? csv(records, fields)
          : jsonExport(records, fields, {
              id,
              createdAt,
              scope: body.scope,
              resolved: resolution.resolved,
              label: resolution.label,
              warnings,
            });
    }

    const fileName = `${id}.${body.format}`;
    const downloadName = `domain-scout-export-${fileStamp(createdAt)}.${body.format}`;
    const sizeBytes = this.store.write(fileName, content);
    const options: ExportOptions = {
      fields,
      includeNotes: body.includeNotes,
      candidatesOnly,
      downloadName,
      resolved: resolution.resolved,
    };
    this.store.insert({
      id,
      kind: 'export',
      title: null,
      format: body.format,
      scope: body.scope,
      options,
      itemCount,
      fileName,
      sizeBytes,
      warnings,
      createdAt,
    });
    return this.get(id);
  }

  list(): ExportArtifact[] {
    return this.store.list('export').map(toArtifact);
  }

  get(id: string): ExportArtifact {
    return toArtifact(this.store.get('export', id));
  }

  download(id: string): { body: Buffer; contentType: string; fileName: string } {
    const row = this.store.get('export', id);
    const options = json.parse<Partial<ExportOptions>>(row.options_json, {});
    return {
      body: this.store.read(row.file_name),
      contentType: CONTENT_TYPES[row.format as Format] ?? 'application/octet-stream',
      fileName: options.downloadName ?? row.file_name,
    };
  }

  delete(id: string) {
    const row = this.store.get('export', id);
    this.store.delete('export', id, [row.file_name]);
  }

  /**
   * Chosen fields (default DEFAULT_EXPORT_FIELDS) plus the fields that keep uncertainty visible.
   * Notes appear only when includeNotes is set.
   */
  private fields(body: ExportInput, warnings: string[]): ExportField[] {
    const chosen = [...new Set(body.fields?.length ? body.fields : DEFAULT_EXPORT_FIELDS)];
    const missing = REQUIRED_STRUCTURED_FIELDS.filter((f) => !chosen.includes(f));
    if (missing.length) {
      warnings.push(`Added fields that keep status, source, check time and price type: ${missing.join(', ')}`);
    }
    let fields = [...chosen, ...missing.filter((f) => f !== 'domain')];
    if (missing.includes('domain')) fields.unshift('domain');
    if (body.includeNotes && !fields.includes('notes')) fields.push('notes');
    if (!body.includeNotes && fields.includes('notes')) {
      warnings.push('Private notes were left out because includeNotes is false');
      fields = fields.filter((f) => f !== 'notes');
    }
    return fields;
  }
}

function txt(names: string[], meta: { createdAt: string; label: string; candidatesOnly: boolean }): string {
  const header = [
    '# Domain Scout candidate list',
    `# Created ${meta.createdAt}`,
    `# Scope: ${oneLine(meta.label)}`,
    `# Names: ${names.length}`,
    ...(meta.candidatesOnly
      ? ['# Kept only names with no registry record or a positive provider confirmation at check time.']
      : ['# Includes every name in scope, whatever its registry outcome.']),
    ...UNCERTAINTY_NOTICE.map((line) => `# ${line}`),
  ];
  return `${[...header, ...names].join('\n')}\n`;
}

function csv(records: ScopedRecord[], fields: ExportField[]): string {
  const lines = [csvLine(fields)];
  for (const record of records) {
    const price = pickPrice(record);
    lines.push(csvLine(fields.map((field) => fieldValue(record, field, price))));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function jsonExport(
  records: ScopedRecord[],
  fields: ExportField[],
  meta: { id: string; createdAt: string; scope: ExportScope; resolved: ResolvedScope; label: string; warnings: string[] },
): string {
  const items = records.map((record) => {
    const price = pickPrice(record);
    const row: Record<string, unknown> = {};
    for (const field of fields) row[field] = fieldValue(record, field, price);
    // Name checks, diagnostics and listings stay separate evidence, each with its own source and time.
    if (record.other.length) row.checks = record.other.map((check) => ({ ...check }));
    return row;
  });
  const document = {
    contractVersion: CONTRACT_VERSION,
    kind: 'domain-scout-export',
    id: meta.id,
    createdAt: meta.createdAt,
    scope: meta.scope,
    scopeLabel: meta.label,
    resolved: meta.resolved,
    fields,
    notice: UNCERTAINTY_NOTICE,
    warnings: meta.warnings,
    items,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

function toArtifact(row: ArtifactRow): ExportArtifact {
  const options = json.parse<Partial<ExportOptions>>(row.options_json, {});
  return {
    id: row.id,
    format: row.format as Format,
    scope: json.parse<ExportScope>(row.scope_json, { kind: 'all' }),
    fields: options.fields ?? [],
    itemCount: row.item_count,
    fileName: options.downloadName ?? row.file_name,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    downloadPath: `${API_PREFIX}/exports/${row.id}/download`,
    warnings: json.parse<string[]>(row.warnings_json, []),
  };
}
