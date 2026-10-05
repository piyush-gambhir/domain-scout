import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GenerationRequest, type GenerationRequest as GenerationInput } from '@domain-scout/contracts';
import { AppError } from '../../src/core/errors.js';
import { GenerationService, domainIssues, ldhIssues, mulberry32 } from '../../src/discovery/generation.service.js';
import { DEFAULT_THEME_DIR, ThemeLibrary } from '../../src/discovery/themes.js';

const service = new GenerationService(new ThemeLibrary());
const gen = (input: GenerationInput) => service.preview(GenerationRequest.parse(input));
const names = (input: GenerationInput) => gen(input).candidates.map((c) => c.name);
const find = (input: GenerationInput, name: string) => gen(input).candidates.find((c) => c.name === name);

describe('generation strategies', () => {
  it('roots are lowercased and trimmed', () => {
    const result = gen({ roots: [' Cloud ', 'nimbus'], strategies: ['roots'] });
    expect(result.candidates).toEqual([
      { name: 'cloud', domain: null, strategy: 'roots', rule: 'root cloud', valid: true, issues: [] },
      { name: 'nimbus', domain: null, strategy: 'roots', rule: 'root nimbus', valid: true, issues: [] },
    ]);
  });

  it('affixes combine prefixes and suffixes with roots', () => {
    const input: GenerationInput = { roots: ['cloud'], prefixes: ['get'], suffixes: ['hq'], strategies: ['affixes'] };
    expect(find(input, 'getcloud')?.rule).toBe('prefix get + root cloud');
    expect(find(input, 'cloudhq')?.rule).toBe('root cloud + suffix hq');
    expect(names(input)).toHaveLength(2);
  });

  it('affixes fall back to theme words when no roots are given', () => {
    const result = gen({ themes: ['nature'], prefixes: ['my'], strategies: ['affixes'], limit: 5000 });
    expect(result.candidates.find((c) => c.name === 'mysky')?.rule).toBe('prefix my + theme word sky (nature)');
  });

  it('compounds pair roots with theme words in both orders', () => {
    const input: GenerationInput = { roots: ['cloud'], themes: ['nature'], strategies: ['compounds'], limit: 5000 };
    expect(find(input, 'cloudsky')?.rule).toBe('root cloud + theme word sky (nature)');
    expect(find(input, 'skycloud')?.rule).toBe('theme word sky (nature) + root cloud');
  });

  it('compounds pair theme words when no roots are given, and roots with roots when no themes are given', () => {
    const themeOnly = gen({ themes: ['short'], strategies: ['compounds'], limit: 5000 });
    expect(themeOnly.counts.generated).toBe(60 * 59);
    expect(themeOnly.candidates[0]?.rule).toMatch(/^theme word \w+ \(short\) \+ theme word \w+ \(short\)$/);

    const rootsOnly = names({ roots: ['blue', 'fox'], strategies: ['compounds'] });
    expect(rootsOnly).toEqual(['bluefox', 'foxblue']);
  });

  it('mutations apply vowel drop, -ly, -ify, -io, doubled letters and plurals', () => {
    const result = gen({ roots: ['flicker', 'spot', 'party'], strategies: ['mutations'], limit: 5000 });
    const rule = (name: string) => result.candidates.find((c) => c.name === name)?.rule;
    expect(rule('flckr')).toBe('mutation vowel drop of root flicker');
    expect(rule('flickerly')).toBe('mutation -ly of root flicker');
    expect(rule('spotify')).toBe('mutation -ify of root spot');
    expect(rule('spotio')).toBe('mutation -io of root spot');
    expect(rule('spott')).toBe('mutation doubled final letter of root spot');
    expect(rule('flickers')).toBe('mutation plural of root flicker');
    expect(rule('parties')).toBe('mutation plural of root party');
    expect(rule('partyly')).toBeUndefined();
  });

  it('syllables are deterministic for a seed and default to seed 1', () => {
    const a = gen({ strategies: ['syllables'], seed: 7, limit: 50 });
    const b = gen({ strategies: ['syllables'], seed: 7, limit: 50 });
    const c = gen({ strategies: ['syllables'], seed: 8, limit: 50 });
    expect(a).toEqual(b);
    expect(a.candidates.map((x) => x.name)).not.toEqual(c.candidates.map((x) => x.name));
    expect(gen({ strategies: ['syllables'], limit: 20 })).toEqual(gen({ strategies: ['syllables'], seed: 1, limit: 20 }));
    for (const candidate of a.candidates) {
      expect(candidate.rule).toMatch(/^syllables CVC?(-CVC?){1,2} seed 7$/);
      expect(candidate.name).toMatch(/^[a-z]{4,9}$/);
    }
    // A smaller limit returns a prefix of the same sequence.
    const short = gen({ strategies: ['syllables'], seed: 7, limit: 10 }).candidates.map((x) => x.name);
    expect(a.candidates.map((x) => x.name).slice(0, short.length)).toEqual(short);
  });

  it('mulberry32 is a stable sequence', () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    const seq1 = Array.from({ length: 5 }, () => r1());
    expect(seq1).toEqual(Array.from({ length: 5 }, () => r2()));
    expect(seq1.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('domain hacks split a word at a matching single-label extension', () => {
    const result = gen({ roots: ['bitly', 'delicious'], strategies: ['hacks'], extensions: ['ly', 'us'] });
    expect(result.candidates).toEqual([
      { name: 'bit.ly', domain: 'bit.ly', strategy: 'hacks', rule: 'hack root bitly read as bit.ly', valid: true, issues: [] },
      {
        name: 'delicio.us',
        domain: 'delicio.us',
        strategy: 'hacks',
        rule: 'hack root delicious read as delicio.us',
        valid: true,
        issues: [],
      },
    ]);
    expect(result.expandedChecks).toBe(2);
  });

  it('flags hacks across a multi-label suffix as a registration boundary issue', () => {
    const hack = gen({ roots: ['brandcouk'], strategies: ['hacks'], extensions: ['co.uk'] }).candidates[0];
    expect(hack?.domain).toBe('brand.co.uk');
    expect(hack?.valid).toBe(false);
    expect(hack?.issues[0]).toMatch(/^registration boundary: co\.uk has more than one label/);
  });

  it('notes short hack labels and skips words equal to the extension', () => {
    const result = gen({ roots: ['goly', 'ly'], strategies: ['hacks'], extensions: ['ly'], rules: { minLength: 1 } });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.name).toBe('go.ly');
    expect(result.candidates[0]?.valid).toBe(true);
    expect(result.candidates[0]?.issues).toEqual(['one and two character labels are often reserved or premium']);
  });

  it('interleaves strategies so a small limit still shows each one', () => {
    const result = gen({ roots: ['cloud'], themes: ['tech'], prefixes: ['get'], strategies: ['roots', 'affixes', 'compounds'], limit: 3 });
    expect(result.candidates.map((c) => c.strategy)).toEqual(['roots', 'affixes', 'compounds']);
  });
});

describe('rules, validation and counts', () => {
  it('filters by length and reports counts', () => {
    const result = gen({ roots: ['ab', 'abcdef', 'abcdefghijklmnop'], strategies: ['roots'] });
    expect(result.candidates.map((c) => c.name)).toEqual(['abcdef']);
    expect(result.counts).toEqual({ generated: 3, unique: 3, duplicates: 0, invalid: 0, filtered: 2 });
  });

  it('applies digit, hyphen and exclusion rules', () => {
    expect(names({ roots: ['web3', 'my-brand', 'cloud'], strategies: ['roots'] })).toEqual(['cloud']);
    expect(
      names({ roots: ['web3', 'my-brand'], strategies: ['roots'], rules: { allowDigits: true, allowHyphens: true } }),
    ).toEqual(['web3', 'my-brand']);
    // Exclusion matches exact labels and labels containing the term.
    expect(names({ roots: ['bad', 'badcloud', 'cloud'], strategies: ['roots'], rules: { exclude: ['Bad'] } })).toEqual(['cloud']);
  });

  it('keeps LDH-invalid candidates with valid=false and issues', () => {
    const roots = ['-lead', 'trail-', 'ab--cd', 'xn--abc', 'bad_char', 'café'];
    const result = gen({
      roots,
      strategies: ['roots'],
      rules: { minLength: 1, maxLength: 63, allowHyphens: true, allowDigits: true },
    });
    expect(result.counts.invalid).toBe(roots.length);
    expect(result.candidates.every((c) => !c.valid && c.issues.length > 0)).toBe(true);
    expect(result.expandedChecks).toBe(0);
  });

  it('flags generated labels longer than 63 characters', () => {
    const result = gen({
      roots: ['r'.repeat(40)],
      prefixes: ['p'.repeat(30)],
      strategies: ['affixes'],
      rules: { maxLength: 63 },
    });
    expect(result.candidates[0]?.valid).toBe(false);
    expect(result.candidates[0]?.issues).toEqual(['label longer than 63 characters']);
  });

  it('ldhIssues explains each failure', () => {
    expect(ldhIssues('cloud')).toEqual([]);
    expect(ldhIssues('')).toEqual(['empty label']);
    expect(ldhIssues('-x')).toEqual(['hyphen at the start or end of the label']);
    expect(ldhIssues('xn--abc')).toEqual(['hyphens in the third and fourth positions are reserved (for example xn--)']);
    expect(ldhIssues('a_b')).toEqual(['invalid characters: only a-z, 0-9 and hyphen are allowed']);
    expect(ldhIssues('a'.repeat(64))).toEqual(['label longer than 63 characters']);
  });

  it('counts duplicates across inputs and strategies', () => {
    const result = gen({ roots: ['cloud', 'Cloud', ' cloud '], strategies: ['roots'] });
    expect(result.counts).toEqual({ generated: 3, unique: 1, duplicates: 2, invalid: 0, filtered: 0 });
  });

  it('expandedChecks multiplies valid labels by extensions and adds valid hacks', () => {
    const result = gen({
      roots: ['bitly', 'cloud', 'bad_x'],
      strategies: ['roots', 'hacks'],
      extensions: ['ly', 'com', 'com'],
    });
    expect(result.extensions).toEqual(['ly', 'com']);
    expect(result.candidates.map((c) => c.name)).toEqual(['bitly', 'bit.ly', 'cloud', 'bad_x']);
    expect(result.expandedChecks).toBe(2 * 2 + 1);
  });

  it('expandedChecks counts each complete domain once when a label and a hack overlap', () => {
    // Expansion yields bitly.ly and bit.ly; the hack bit.ly equals the label bit under ly.
    const result = gen({ roots: ['bitly', 'bit'], strategies: ['roots', 'hacks'], extensions: ['ly'] });
    expect(result.candidates.map((c) => c.name)).toEqual(['bitly', 'bit.ly', 'bit']);
    expect(result.expandedChecks).toBe(2);
  });

  it('expandedChecks skips label expansions longer than 253 characters', () => {
    const long = Array.from({ length: 4 }, (_, i) => String.fromCharCode(97 + i).repeat(62)).join('.');
    expect(long.length).toBe(251);
    expect(gen({ roots: ['cloud'], strategies: ['roots'], extensions: ['com', long] }).expandedChecks).toBe(1);
  });

  it('rejects extensions whose labels fail LDH and accepts IDN A-label extensions', () => {
    expect(() => gen({ roots: ['brandbad-'], strategies: ['hacks'], extensions: ['bad-'] })).toThrow(AppError);
    expect(() => gen({ roots: ['cloud'], strategies: ['roots'], extensions: ['com', 'co.-uk'] })).toThrow(AppError);
    const idn = gen({ roots: ['cloud'], strategies: ['roots'], extensions: ['xn--p1ai'] });
    expect(idn.extensions).toEqual(['xn--p1ai']);
    expect(idn.expandedChecks).toBe(1);
  });

  it('domainIssues validates the label, every extension label and the total length', () => {
    expect(domainIssues('bit', 'ly')).toEqual([]);
    expect(domainIssues('brand', 'bad-')).toEqual(['extension label bad-: hyphen at the start or end of the label']);
    expect(domainIssues('brand', 'xn--p1ai')).toEqual([]);
    const long = Array.from({ length: 4 }, () => 'a'.repeat(62)).join('.');
    expect(domainIssues('x'.repeat(10), long)).toEqual(['domain longer than 253 characters']);
  });

  it('respects the limit in a deterministic order', () => {
    const input: GenerationInput = { roots: ['cloud'], themes: ['tech', 'nature'], strategies: ['compounds', 'mutations'], limit: 25 };
    const result = gen(input);
    expect(result.candidates).toHaveLength(25);
    expect(gen(input)).toEqual(result);
  });

  it('ignores unknown theme ids', () => {
    const input: GenerationInput = { roots: ['cloud'], strategies: ['compounds'], limit: 5000 };
    expect(gen({ ...input, themes: ['nature', 'no-such-theme'] })).toEqual(gen({ ...input, themes: ['nature'] }));
  });

  it('bounds raw generation', () => {
    const result = gen({
      roots: Array.from({ length: 50 }, (_, i) => `root${String.fromCharCode(97 + (i % 26))}${i}`),
      themes: ['tech', 'nature', 'finance', 'abstract', 'short'],
      strategies: ['compounds'],
      rules: { allowDigits: true, maxLength: 63 },
    });
    expect(result.counts.generated).toBe(20_000);
    expect(result.candidates).toHaveLength(300);
  });

  it('rejects contradictory length rules', () => {
    expect(() => gen({ roots: ['cloud'], rules: { minLength: 10, maxLength: 5 } })).toThrow(AppError);
  });
});

describe('themes', () => {
  it('bundles several hundred lowercase words per theme', () => {
    const themes = service.themes();
    expect(themes.map((t) => t.id).sort()).toEqual(['abstract', 'finance', 'nature', 'short', 'tech']);
    for (const theme of themes) {
      expect(theme.size).toBeGreaterThanOrEqual(200);
      expect(theme.sample.length).toBeLessThanOrEqual(8);
    }
  });

  it('theme files are valid, unique and ASCII lowercase', () => {
    for (const file of readdirSync(DEFAULT_THEME_DIR).filter((f) => f.endsWith('.json'))) {
      const parsed = JSON.parse(readFileSync(`${DEFAULT_THEME_DIR}/${file}`, 'utf8')) as { id: string; words: string[] };
      expect(file).toBe(`${parsed.id}.json`);
      expect(new Set(parsed.words).size).toBe(parsed.words.length);
      expect(parsed.words.every((w) => /^[a-z]+$/.test(w))).toBe(true);
    }
  });
});
