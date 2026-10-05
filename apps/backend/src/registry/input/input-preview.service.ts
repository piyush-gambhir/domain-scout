import { Injectable } from '@nestjs/common';
import type {
  ExtensionPreset,
  InputPreview,
  InputPreviewRow,
  InputReason,
  InputSourceParsed,
  NormalizedDomain,
} from '@domain-scout/contracts';
import { domainToASCII } from 'node:url';
import { InputPreviewer } from '../../core/ports.js';
import { AppError } from '../../core/errors.js';
import { Database, json } from '../../storage/database.js';
import { loadRegistryData } from '../data.js';
import { classifyDomain, classifyEntry, cleanEntry, reason, type SuffixLookup } from './domain-rules.js';
import { parseText, type RawEntry } from './parse-input.js';

/** Upper bound on preview rows after expansion; larger requests fail explicitly instead of exhausting memory. */
export const MAX_PREVIEW_ROWS = 250_000;

/**
 * Input normalization (A03, A04, B01-B03): parsing, validation, IDN conversion, base-name expansion
 * and deduplication. Purely local: nothing here touches the network.
 */
@Injectable()
export class InputPreviewService extends InputPreviewer implements SuffixLookup {
  private readonly rootTlds: Set<string>;

  constructor(private readonly db: Database) {
    super();
    this.rootTlds = new Set(loadRegistryData().rootTlds.tlds);
  }

  isRootTld(tld: string): boolean {
    return this.rootTlds.has(tld);
  }

  /** Built-in extension presets (user presets live in extension_presets, owned by collections). */
  presets(): ExtensionPreset[] {
    return loadRegistryData().presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      extensions: [...preset.extensions],
      builtIn: true,
      createdAt: null,
    }));
  }

  /** Suffixes for a built-in or saved preset id; throws a 400 for an unknown id. */
  presetExtensions(presetId: string): string[] {
    const builtIn = loadRegistryData().presets.find((preset) => preset.id === presetId);
    if (builtIn) return [...builtIn.extensions];
    const row = this.db.get<{ extensions_json: string }>('SELECT extensions_json FROM extension_presets WHERE id = ?', [presetId]);
    if (row) return json.parse<string[]>(row.extensions_json, []);
    throw AppError.invalid(`Unknown extension preset "${presetId}"`, [{ path: 'body.presetId', message: 'No built-in or saved preset has this id' }]);
  }

  normalize(domain: string): NormalizedDomain | null {
    const verdict = this.normalizeDetailed(domain);
    return verdict.domain;
  }

  /** Like normalize() but keeps the reasons, for handlers that must explain an invalid item. */
  normalizeDetailed(domain: string): { domain: NormalizedDomain | null; reasons: InputReason[]; suggestion: string | null } {
    const cleaned = cleanEntry(domain);
    const verdict = classifyEntry(cleaned.value, this);
    if (verdict.kind === 'domain') return { domain: verdict.domain, reasons: [...cleaned.reasons, ...verdict.reasons], suggestion: null };
    if (verdict.kind === 'base') {
      return {
        domain: null,
        reasons: [...cleaned.reasons, reason('no_extensions_selected', `"${verdict.unicodeLabel}" has no extension; a complete domain is required`)],
        suggestion: null,
      };
    }
    return { domain: null, reasons: [...cleaned.reasons, ...verdict.reasons], suggestion: verdict.kind === 'ambiguous' ? verdict.suggestion : null };
  }

  preview(source: InputSourceParsed): InputPreview {
    const extensions = this.resolveExtensions(source);
    const entries: RawEntry[] = [];
    let lineCount = 0;
    if (source.text !== undefined && source.text !== '') {
      const parsed = parseText(source.text, source.format, source.csvColumn);
      for (const entry of parsed.entries) entries.push(entry);
      lineCount = parsed.lineCount;
    }
    (source.domains ?? []).forEach((text, index) => entries.push({ row: lineCount + index + 1, text }));

    const rows: InputPreviewRow[] = [];
    const firstRowByDomain = new Map<string, number>();
    const domains: string[] = [];

    const pushRow = (row: InputPreviewRow) => {
      if (rows.length >= MAX_PREVIEW_ROWS) {
        throw AppError.invalid(`Input expands to more than ${MAX_PREVIEW_ROWS} rows; split it or select fewer extensions`);
      }
      if (row.status === 'valid' && row.domain) {
        const first = firstRowByDomain.get(row.domain.ascii);
        if (first !== undefined) {
          row.status = 'duplicate';
          row.duplicateOf = row.domain.ascii;
          row.reasons = [...row.reasons, reason('duplicate', `Repeats ${row.domain.ascii} from row ${first}`)];
        } else {
          firstRowByDomain.set(row.domain.ascii, row.row);
          domains.push(row.domain.ascii);
        }
      }
      rows.push(row);
    };

    for (const entry of entries) {
      const cleaned = cleanEntry(entry.text);
      const verdict = classifyEntry(cleaned.value, this);
      const base = { row: entry.row, original: entry.text, suggestion: null, duplicateOf: null, expandedFrom: null };

      if (verdict.kind === 'domain') {
        pushRow({ ...base, status: 'valid', domain: verdict.domain, reasons: [...cleaned.reasons, ...verdict.reasons] });
      } else if (verdict.kind === 'ambiguous') {
        pushRow({ ...base, status: 'ambiguous', domain: null, suggestion: verdict.suggestion, reasons: [...cleaned.reasons, ...verdict.reasons] });
      } else if (verdict.kind === 'invalid') {
        pushRow({ ...base, status: 'invalid', domain: null, reasons: [...cleaned.reasons, ...verdict.reasons] });
      } else if (extensions.length === 0) {
        pushRow({
          ...base,
          status: 'invalid',
          domain: null,
          reasons: [...cleaned.reasons, ...verdict.reasons, reason('no_extensions_selected', `"${verdict.unicodeLabel}" has no extension and none are selected`)],
        });
      } else {
        for (const suffix of extensions) {
          const expanded = classifyDomain(`${verdict.label}.${suffix}`, null, this);
          const expandedReasons: InputReason[] = [
            ...cleaned.reasons,
            ...verdict.reasons,
            reason('expanded_from_base', `Expanded "${verdict.unicodeLabel}" with .${suffix}`),
            ...expanded.reasons,
          ];
          const expandedBase = { ...base, expandedFrom: verdict.unicodeLabel };
          if (expanded.kind === 'domain') {
            pushRow({ ...expandedBase, status: 'valid', domain: expanded.domain, reasons: expandedReasons });
          } else if (expanded.kind === 'ambiguous') {
            pushRow({ ...expandedBase, status: 'ambiguous', domain: null, suggestion: expanded.suggestion, reasons: expandedReasons });
          } else {
            pushRow({ ...expandedBase, status: 'invalid', domain: null, reasons: expandedReasons });
          }
        }
      }
    }

    const count = (status: InputPreviewRow['status']) => rows.filter((row) => row.status === status).length;
    return {
      rows,
      domains,
      extensions,
      counts: {
        inputRows: entries.length,
        valid: count('valid'),
        duplicate: count('duplicate'),
        invalid: count('invalid'),
        ambiguous: count('ambiguous'),
        uniqueDomains: domains.length,
        totalChecks: domains.length,
      },
    };
  }

  /** Selected extensions plus the preset's, lower-cased A-labels without leading dots, first occurrence kept. */
  private resolveExtensions(source: InputSourceParsed): string[] {
    const requested = [...source.extensions, ...(source.presetId ? this.presetExtensions(source.presetId) : [])];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of requested) {
      const cleaned = raw.trim().toLowerCase().replace(/^\.+/, '');
      const ascii = domainToASCII(cleaned) || cleaned;
      if (ascii === '' || seen.has(ascii)) continue;
      seen.add(ascii);
      out.push(ascii);
    }
    return out;
  }
}
