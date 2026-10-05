import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InputSource, type InputPreview, type InputPreviewRow } from '@domain-scout/contracts';
import { Database } from '../../src/storage/database.js';
import { AppError } from '../../src/core/errors.js';
import { InputPreviewService } from '../../src/registry/input/input-preview.service.js';
import { parseCsv } from '../../src/registry/input/parse-input.js';
import { createTestApp, type TestApp } from '../helpers.js';

let db: Database;
let service: InputPreviewService;

beforeAll(() => {
  db = new Database(':memory:');
  db.migrate();
  service = new InputPreviewService(db);
});
afterAll(() => db.close());

const preview = (input: Parameters<typeof InputSource.parse>[0]): InputPreview => service.preview(InputSource.parse(input));
const codes = (row: InputPreviewRow) => row.reasons.map((r) => r.code);
const byOriginal = (p: InputPreview, original: string) => p.rows.filter((r) => r.original === original);

describe('acceptance scenario 1: mixed pasted input', () => {
  const text = [
    'acme.com',
    'Acme.COM',
    'https://www.Example.com/pricing?x=1',
    'brandname',
    'münchen.de',
    'bbc.co.uk',
    'www.bbc.co.uk',
    'portfolio.github.io',
    'co.uk',
    '.com',
    'acme.zzzz',
    '-acme.com',
    'ab--cd.com',
    `${'a'.repeat(64)}.com`,
    'acme_corp.com',
    '',
    'example.com.',
    'acme.com',
  ].join('\n');
  let p: InputPreview;
  beforeAll(() => {
    p = preview({ text, extensions: ['com', 'io'] });
  });

  it('accounts for every entry with the right status', () => {
    const summary = p.rows.map((r) => [r.original, r.status, r.domain?.ascii ?? r.suggestion ?? null]);
    expect(summary).toEqual([
      ['acme.com', 'valid', 'acme.com'],
      ['Acme.COM', 'duplicate', 'acme.com'],
      ['https://www.Example.com/pricing?x=1', 'ambiguous', 'example.com'],
      ['brandname', 'valid', 'brandname.com'],
      ['brandname', 'valid', 'brandname.io'],
      ['münchen.de', 'valid', 'xn--mnchen-3ya.de'],
      ['bbc.co.uk', 'valid', 'bbc.co.uk'],
      ['www.bbc.co.uk', 'ambiguous', 'bbc.co.uk'],
      ['portfolio.github.io', 'invalid', null],
      ['co.uk', 'invalid', null],
      ['.com', 'invalid', null],
      ['acme.zzzz', 'invalid', null],
      ['-acme.com', 'invalid', null],
      ['ab--cd.com', 'invalid', null],
      [`${'a'.repeat(64)}.com`, 'invalid', null],
      ['acme_corp.com', 'invalid', null],
      ['example.com.', 'valid', 'example.com'],
      ['acme.com', 'duplicate', 'acme.com'],
    ]);
  });

  it('counts exactly and keeps unique domains in input order', () => {
    expect(p.counts).toEqual({ inputRows: 17, valid: 6, duplicate: 2, invalid: 8, ambiguous: 2, uniqueDomains: 6, totalChecks: 6 });
    expect(p.domains).toEqual(['acme.com', 'brandname.com', 'brandname.io', 'xn--mnchen-3ya.de', 'bbc.co.uk', 'example.com']);
    expect(p.extensions).toEqual(['com', 'io']);
  });

  it('keeps 1-based line numbers, skipping blank lines without inventing rows', () => {
    expect(byOriginal(p, 'example.com.')[0]!.row).toBe(17);
    expect(byOriginal(p, 'brandname').map((r) => r.row)).toEqual([4, 4]);
  });

  it('explains each exclusion and normalization', () => {
    const reasonOf = (original: string) => codes(byOriginal(p, original)[0]!);
    expect(reasonOf('Acme.COM')).toEqual(['normalized_case', 'duplicate']);
    expect(reasonOf('https://www.Example.com/pricing?x=1')).toEqual(['stripped_url', 'normalized_case', 'hostname_not_registrable']);
    expect(reasonOf('portfolio.github.io')).toEqual(['private_suffix']);
    expect(reasonOf('co.uk')).toEqual(['suffix_only']);
    expect(reasonOf('.com')).toEqual(['suffix_only']);
    expect(reasonOf('acme.zzzz')).toEqual(['unknown_suffix']);
    expect(reasonOf('-acme.com')).toEqual(['hyphen_position']);
    expect(reasonOf('ab--cd.com')).toEqual(['hyphen_position']);
    expect(reasonOf(`${'a'.repeat(64)}.com`)).toEqual(['label_too_long']);
    expect(reasonOf('acme_corp.com')).toEqual(['invalid_characters']);
    expect(reasonOf('example.com.')).toEqual(['trailing_dot_removed']);
    expect(reasonOf('brandname')).toEqual(['expanded_from_base']);
  });

  it('points duplicates at the first occurrence', () => {
    const dup = byOriginal(p, 'Acme.COM')[0]!;
    expect(dup.duplicateOf).toBe('acme.com');
    expect(dup.reasons.find((r) => r.code === 'duplicate')!.message).toContain('row 1');
  });

  it('records expansion source and IDN display form', () => {
    expect(byOriginal(p, 'brandname')[1]!.expandedFrom).toBe('brandname');
    const idn = byOriginal(p, 'münchen.de')[0]!;
    expect(idn.domain).toEqual({ ascii: 'xn--mnchen-3ya.de', unicode: 'münchen.de', label: 'xn--mnchen-3ya', suffix: 'de', isIdn: true });
    expect(codes(idn)).toEqual(['idn_converted', 'idn_support_unknown']);
  });

  it('uses ICANN multi-label suffixes as registration boundaries', () => {
    expect(byOriginal(p, 'bbc.co.uk')[0]!.domain).toMatchObject({ label: 'bbc', suffix: 'co.uk' });
    expect(byOriginal(p, 'www.bbc.co.uk')[0]!.suggestion).toBe('bbc.co.uk');
  });
});

describe('normalization details', () => {
  it('accepts A-label input and rejects invalid xn-- labels', () => {
    const p = preview({ domains: ['xn--mnchen-3ya.de', 'xn--abc.com', 'faß.de'] });
    expect(p.rows.map((r) => [r.status, r.domain?.unicode ?? null, codes(r)[0]])).toEqual([
      ['valid', 'münchen.de', 'idn_support_unknown'],
      ['invalid', null, 'idn_invalid'],
      ['valid', 'faß.de', 'idn_converted'],
    ]);
    expect(p.rows[2]!.domain!.ascii).toBe('xn--fa-hia.de');
  });

  it('strips ports, credentials and fragments from URLs', () => {
    const p = preview({ domains: ['http://user:pw@acme.io:8080/a#b', 'acme.dev:443', 'acme.app/path'] });
    expect(p.rows.map((r) => r.domain?.ascii)).toEqual(['acme.io', 'acme.dev', 'acme.app']);
    expect(p.rows.every((r) => codes(r).includes('stripped_url'))).toBe(true);
  });

  it('refuses characters that URL host parsing would rewrite silently', () => {
    const p = preview({ domains: ['acme%2ecom', 'google.com\\bad', 'acme;com', 'xn--mnchen-3ya.de'] });
    expect(p.rows.map((r) => [r.status, codes(r)[0]])).toEqual([
      ['invalid', 'invalid_characters'],
      ['invalid', 'invalid_characters'],
      ['invalid', 'invalid_characters'],
      ['valid', 'idn_support_unknown'],
    ]);
  });

  it('rejects names over 253 characters', () => {
    const long = `${Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.')}.com`;
    const p = preview({ domains: [long] });
    // A 5-label name is first a host name; length is checked before the boundary.
    expect(codes(p.rows[0]!)).toEqual(['name_too_long']);
  });

  it('flags base names without extensions instead of dropping them', () => {
    const p = preview({ text: 'acme\nbeta' });
    expect(p.rows.map((r) => [r.status, codes(r)])).toEqual([
      ['invalid', ['no_extensions_selected']],
      ['invalid', ['no_extensions_selected']],
    ]);
    expect(p.counts).toMatchObject({ inputRows: 2, invalid: 2, uniqueDomains: 0, totalChecks: 0 });
  });

  it('expands IDN base names and keeps complete domains on their own suffix', () => {
    const p = preview({ text: 'bücher acme.org', extensions: ['de', 'com'] });
    expect(p.domains).toEqual(['xn--bcher-kva.de', 'xn--bcher-kva.com', 'acme.org']);
    expect(p.rows[0]!.expandedFrom).toBe('bücher');
    expect(p.rows[0]!.domain!.unicode).toBe('bücher.de');
  });

  it('applies wildcard Public Suffix List rules', () => {
    const p = preview({ domains: ['acme.ck', 'www.ck'] });
    expect(p.rows.map((r) => [r.status, codes(r).at(-1)])).toEqual([
      ['invalid', 'suffix_only'],
      ['valid', undefined],
    ]);
  });

  it('treats a private-suffix apex as an ordinary registrable domain', () => {
    const p = preview({ domains: ['github.io', 'blog.github.io'] });
    expect(p.rows.map((r) => r.status)).toEqual(['valid', 'invalid']);
  });

  it('normalize() returns null for non-registrable input', () => {
    expect(service.normalize('Example.COM.')).toMatchObject({ ascii: 'example.com', suffix: 'com' });
    expect(service.normalize('www.example.com')).toBeNull();
    expect(service.normalize('acme')).toBeNull();
    expect(service.normalize('foo.github.io')).toBeNull();
    expect(service.normalizeDetailed('www.example.com').suggestion).toBe('example.com');
  });
});

describe('text, TXT and CSV parsing', () => {
  it('splits pasted lines on whitespace, commas and semicolons', () => {
    const p = preview({ text: 'a1.com, a2.com;a3.com\ta4.com\r\n\r\na5.com' });
    expect(p.rows.map((r) => [r.row, r.domain?.ascii])).toEqual([
      [1, 'a1.com'],
      [1, 'a2.com'],
      [1, 'a3.com'],
      [1, 'a4.com'],
      [3, 'a5.com'],
    ]);
  });

  it('auto-detects CSV with a domain header and reads that column', () => {
    const csv = 'name,domain,notes\nAcme,acme.com,"first, with comma"\nBeta,"beta.io",second\n';
    const p = preview({ text: csv });
    expect(p.rows.map((r) => [r.row, r.original, r.status])).toEqual([
      [2, 'acme.com', 'valid'],
      [3, 'beta.io', 'valid'],
    ]);
  });

  it('honors csvColumn and reports a missing column as a request error', () => {
    const csv = 'Brand;Site\nacme;acme.dev\n';
    expect(preview({ text: csv, csvColumn: 'site' }).domains).toEqual(['acme.dev']);
    expect(() => preview({ text: csv, csvColumn: 'url' })).toThrowError(AppError);
  });

  it('reads the first column of headerless CSV and keeps empty cells as invalid rows', () => {
    const p = preview({ text: 'acme.com,1\n,2\nbeta.com,3\n', format: 'csv' });
    expect(p.rows.map((r) => [r.row, r.status, codes(r)])).toEqual([
      [1, 'valid', []],
      [2, 'invalid', ['empty']],
      [3, 'valid', []],
    ]);
  });

  it('parses quoted fields with escaped quotes and embedded newlines', () => {
    const { records } = parseCsv('a,"b ""q"" c","multi\nline"\nd,e,f', ',');
    expect(records).toEqual([
      { line: 1, fields: ['a', 'b "q" c', 'multi\nline'] },
      { line: 3, fields: ['d', 'e', 'f'] },
    ]);
  });

  it('detects the delimiter outside quoted content', () => {
    const p = preview({ text: '"domain","note"\n"acme.com",";;;;;;"\n"beta.com","ok"\n' });
    expect(p.domains).toEqual(['acme.com', 'beta.com']);
  });

  it('detects the header and delimiter when the first record spans lines', () => {
    const p = preview({ text: '"note\ncontinued";domain\nfoo;acme.com\n' });
    expect(p.rows.map((r) => [r.row, r.original, r.status])).toEqual([[3, 'acme.com', 'valid']]);
  });

  it('reports an unclosed quote instead of merging rows', () => {
    expect(() => preview({ text: 'domain,note\nacme.com,"open\nbeta.com,ok\n', format: 'csv' })).toThrowError(/unclosed quote/);
  });

  it('handles large inputs without exhausting the call stack', () => {
    const p = preview({ text: 'a.com\n'.repeat(130_000) });
    expect(p.counts).toMatchObject({ inputRows: 130_000, valid: 1, duplicate: 129_999 });
  });

  it('numbers domains[] entries after the text lines', () => {
    const p = preview({ text: 'a.com\nb.com', domains: ['c.com', ''] });
    expect(p.rows.map((r) => [r.row, r.status])).toEqual([
      [1, 'valid'],
      [2, 'valid'],
      [3, 'valid'],
      [4, 'invalid'],
    ]);
  });
});

describe('presets', () => {
  it('lists built-in presets', () => {
    const presets = service.presets();
    expect(presets.map((p) => p.id)).toEqual(['popular', 'tech', 'europe', 'commerce']);
    expect(presets.every((p) => p.builtIn && p.createdAt === null)).toBe(true);
  });

  it('expands with built-in and saved presets, deduplicating extensions', () => {
    db.run('INSERT INTO extension_presets (id, name, extensions_json, created_at) VALUES (?, ?, ?, ?)', [
      'user-1',
      'Mine',
      JSON.stringify(['si', 'com']),
      '2026-10-05T00:00:00.000Z',
    ]);
    expect(preview({ text: 'acme', extensions: ['com'], presetId: 'user-1' }).extensions).toEqual(['com', 'si']);
    expect(preview({ text: 'acme', presetId: 'commerce' }).domains).toEqual(['acme.shop', 'acme.store', 'acme.online', 'acme.site']);
  });

  it('rejects an unknown preset id', () => {
    expect(() => preview({ text: 'acme', presetId: 'nope' })).toThrowError(/Unknown extension preset/);
  });
});

describe('POST /inputs/preview', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('returns the preview envelope and treats invalid rows as data', async () => {
    const res = await t.api.post('/inputs/preview').send({ text: 'acme\nbad_name.com\nbbc.co.uk', extensions: ['si'] }).expect(200);
    expect(res.body.data.counts).toMatchObject({ inputRows: 3, valid: 2, invalid: 1 });
    expect(res.body.data.domains).toEqual(['acme.si', 'bbc.co.uk']);
  });

  it('answers 400 for an unknown CSV column', async () => {
    const res = await t.api.post('/inputs/preview').send({ text: 'domain\nacme.com', csvColumn: 'host' }).expect(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});
