import { AppError } from '../../core/errors.js';

/** One raw entry and the 1-based source row (text line, CSV record start line or domains[] index). */
export interface RawEntry {
  row: number;
  text: string;
}

/** Header names recognized when detecting a CSV domain column, most specific first. */
const HEADER_PRIORITY = ['domain', 'domains', 'domain name', 'domain_name', 'domainname', 'fqdn', 'hostname', 'host', 'url', 'website', 'name', 'names'];
const HEADER_NAMES = new Set(HEADER_PRIORITY);

export interface ParsedInput {
  entries: RawEntry[];
  /** Number of physical lines in `text`, used to number domains[] entries after it. */
  lineCount: number;
}

/**
 * Splits pasted text, TXT or CSV content into entries.
 *
 * `auto` reads CSV only when the first record has a recognized header (domain, name, url, ...) or
 * starts with a quoted field; otherwise every line is split on whitespace, commas and semicolons so
 * no token is discarded. CSV without a recognized header reads the first column of every record.
 */
export function parseText(text: string, format: 'auto' | 'lines' | 'csv', csvColumn?: string): ParsedInput {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lineCount = normalized === '' ? 0 : normalized.split('\n').length;
  const useCsv = format === 'csv' || csvColumn !== undefined || (format === 'auto' && looksLikeCsv(normalized));
  return { entries: useCsv ? csvEntries(normalized, csvColumn) : lineEntries(normalized), lineCount };
}

function lineEntries(text: string): RawEntry[] {
  const entries: RawEntry[] = [];
  text.split('\n').forEach((line, index) => {
    for (const token of line.split(/[\s,;]+/)) {
      if (token !== '') entries.push({ row: index + 1, text: token });
    }
  });
  return entries;
}

/** The first non-blank logical CSV record: newlines inside double quotes do not end it. */
function firstRecord(text: string): string | null {
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    const line = text.slice(start, end === -1 ? text.length : end);
    if (line.trim() !== '') break;
    if (end === -1) return null;
    start = end + 1;
  }
  if (start >= text.length) return null;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === '\n' && !quoted) return text.slice(start, i);
  }
  return text.slice(start);
}

/** Picks tab, semicolon or comma by counting occurrences outside double quotes. */
function detectDelimiter(line: string): string {
  const counts: Record<string, number> = { '\t': 0, ';': 0, ',': 0 };
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch]!++;
  }
  if (counts['\t']! > 0) return '\t';
  return counts[';']! > counts[',']! ? ';' : ',';
}

function looksLikeCsv(text: string): boolean {
  const first = firstRecord(text);
  if (first === null) return false;
  if (first.trimStart().startsWith('"')) return true;
  let fields: string[];
  try {
    fields = parseCsv(first, detectDelimiter(first)).records[0]?.fields ?? [];
  } catch {
    return true; // An unbalanced quote: let the CSV parser report it.
  }
  return fields.length >= 2 && fields.some((field) => HEADER_NAMES.has(field.trim().toLowerCase()));
}

interface CsvRecord {
  line: number;
  fields: string[];
}

/** RFC 4180 parser: quoted fields, doubled quotes, delimiters and newlines inside quotes. */
export function parseCsv(text: string, delimiter: string): { records: CsvRecord[] } {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let sawContent = false;

  const endRecord = () => {
    fields.push(field);
    if (sawContent || fields.length > 1) records.push({ line: recordLine, fields });
    fields = [];
    field = '';
    sawContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      inQuotes = true;
      field = '';
      sawContent = true;
    } else if (ch === delimiter) {
      fields.push(field);
      field = '';
      sawContent = true;
    } else if (ch === '\n') {
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += ch;
      if (ch.trim() !== '') sawContent = true;
    }
  }
  if (inQuotes) {
    throw AppError.invalid(`CSV has an unclosed quote starting on line ${recordLine}`, [
      { path: 'body.text', message: 'Close the quoted field or choose format "lines"' },
    ]);
  }
  if (field !== '' || fields.length > 0 || sawContent) endRecord();
  return { records };
}

function csvEntries(text: string, csvColumn?: string): RawEntry[] {
  const first = firstRecord(text);
  if (first === null) return [];
  const { records } = parseCsv(text, detectDelimiter(first));
  if (records.length === 0) return [];

  const header = records[0]!.fields.map((field) => field.trim().toLowerCase());
  let column = 0;
  let hasHeader = false;
  if (csvColumn !== undefined) {
    column = header.indexOf(csvColumn.trim().toLowerCase());
    if (column === -1) {
      throw AppError.invalid(`CSV column "${csvColumn}" not found`, [
        { path: 'body.csvColumn', message: `Available headers: ${records[0]!.fields.join(', ') || '(none)'}` },
      ]);
    }
    hasHeader = true;
  } else {
    const preferred = HEADER_PRIORITY.find((name) => header.includes(name));
    const known = preferred === undefined ? -1 : header.indexOf(preferred);
    if (known !== -1) {
      column = known;
      hasHeader = true;
    }
  }

  return records.slice(hasHeader ? 1 : 0).map((record) => ({ row: record.line, text: record.fields[column] ?? '' }));
}
