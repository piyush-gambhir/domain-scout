import { Inject, Injectable } from '@nestjs/common';
import type {
  GeneratedCandidate,
  GenerationPreview,
  GenerationRequestParsed,
  GenerationStrategy,
  GenerationTheme,
} from '@domain-scout/contracts';
import type { z } from 'zod';
import { AppError } from '../core/errors.js';
import { ThemeLibrary, type ThemeWord } from './themes.js';

/**
 * Local candidate generation (N01-N05). Pure computation over the request and bundled word lists:
 * no network, no AI service, no other module. Nothing generated here is sent anywhere; a scan is a
 * separate, explicit submission.
 */

/** Upper bound on raw candidates per request so large theme combinations stay bounded and fast. */
export const MAX_GENERATED = 20_000;
/** Theme x theme pairs use only this many pool words (about 3,500 ordered pairs). */
export const PAIR_POOL_SIZE = 60;
export const DEFAULT_SEED = 1;

const CONSONANTS = 'bcdfghjklmnprstvz';
const VOWELS = 'aeiou';

interface Raw {
  /** Label, or the complete domain for hacks. */
  name: string;
  domain: string | null;
  /** The registrable label that length and character rules apply to. */
  label: string;
  strategy: GenerationStrategy;
  rule: string;
  /** Informational notes kept on valid candidates. */
  notes: string[];
  /** Ambiguous registration boundary: returned with valid=false so it is never scanned implicitly. */
  boundary: string[];
}

interface Context {
  /** Normalized roots in input order, duplicates kept so the preview counts them. */
  suppliedRoots: string[];
  /** Normalized unique roots used as bases by the other strategies. */
  roots: string[];
  prefixes: string[];
  suffixes: string[];
  pool: ThemeWord[];
  extensions: string[];
  seed: number;
  syllableCount: number;
}

interface Base {
  word: string;
  describe: string;
}

/** Deterministic 32-bit PRNG (mulberry32); the same seed always yields the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** LDH label checks. Generated names never use reserved `xx--` forms, including xn-- A-labels. */
export function ldhIssues(label: string): string[] {
  const issues: string[] = [];
  if (label.length === 0) return ['empty label'];
  if (label.length > 63) issues.push('label longer than 63 characters');
  if (/[^a-z0-9-]/.test(label)) issues.push('invalid characters: only a-z, 0-9 and hyphen are allowed');
  if (label.startsWith('-') || label.endsWith('-')) issues.push('hyphen at the start or end of the label');
  if (label.slice(2, 4) === '--') issues.push('hyphens in the third and fourth positions are reserved (for example xn--)');
  return issues;
}

/** LDH checks for one extension (suffix) label. Unlike generated labels, IDN A-labels (xn--) are allowed. */
export function suffixLabelIssues(label: string): string[] {
  const issues = ldhIssues(label);
  return label.startsWith('xn--') ? issues.filter((i) => !i.startsWith('hyphens in the third')) : issues;
}

/** Every problem with a complete domain: the registrable label, each extension label and the total length. */
export function domainIssues(label: string, extension: string): string[] {
  const issues = [
    ...ldhIssues(label),
    ...extension.split('.').flatMap((part) => suffixLabelIssues(part).map((issue) => `extension label ${part}: ${issue}`)),
  ];
  if (label.length + 1 + extension.length > 253) issues.push('domain longer than 253 characters');
  return issues;
}

const normalize = (values: string[]) => values.map((v) => v.trim().toLowerCase()).filter(Boolean);
const clean = (values: string[]) => [...new Set(normalize(values))];

function mutations(word: string): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const endsVowel = /[aeiouy]$/.test(word);
  if (word.length >= 4) {
    const dropped = word[0] + word.slice(1).replace(/[aeiou]/g, '');
    if (dropped !== word && dropped.length >= 2) out.push({ value: dropped, label: 'vowel drop' });
  }
  if (!word.endsWith('ly') && !word.endsWith('y')) out.push({ value: `${word}ly`, label: '-ly' });
  if (!word.endsWith('ify')) {
    const stem = endsVowel ? word.slice(0, -1) : word;
    if (stem.length >= 2) out.push({ value: `${stem}ify`, label: '-ify' });
  }
  if (!word.endsWith('io')) {
    const stem = endsVowel ? word.slice(0, -1) : word;
    if (stem.length >= 2) out.push({ value: `${stem}io`, label: '-io' });
  }
  const last = word.at(-1);
  if (last && /[a-z]/.test(last) && !word.endsWith(last + last)) out.push({ value: word + last, label: 'doubled final letter' });
  if (/(s|x|z|ch|sh)$/.test(word)) out.push({ value: `${word}es`, label: 'plural' });
  else if (/[^aeiou]y$/.test(word)) out.push({ value: `${word.slice(0, -1)}ies`, label: 'plural' });
  else out.push({ value: `${word}s`, label: 'plural' });
  return out;
}

function label(raw: Omit<Raw, 'domain' | 'label' | 'notes' | 'boundary'>): Raw {
  return { ...raw, domain: null, label: raw.name, notes: [], boundary: [] };
}

function* rootsStrategy(ctx: Context): Generator<Raw> {
  for (const root of ctx.suppliedRoots) yield label({ name: root, strategy: 'roots', rule: `root ${root}` });
}

/** Affixes and mutations apply to roots, or to the selected theme words when no roots are given. */
function bases(ctx: Context): Base[] {
  if (ctx.roots.length) return ctx.roots.map((word) => ({ word, describe: `root ${word}` }));
  return ctx.pool.map(({ word, theme }) => ({ word, describe: `theme word ${word} (${theme})` }));
}

function* affixesStrategy(ctx: Context): Generator<Raw> {
  for (const base of bases(ctx)) {
    for (const prefix of ctx.prefixes) {
      yield label({ name: prefix + base.word, strategy: 'affixes', rule: `prefix ${prefix} + ${base.describe}` });
    }
    for (const suffix of ctx.suffixes) {
      yield label({ name: base.word + suffix, strategy: 'affixes', rule: `${base.describe} + suffix ${suffix}` });
    }
  }
}

function* compoundsStrategy(ctx: Context): Generator<Raw> {
  if (ctx.roots.length && ctx.pool.length) {
    for (const root of ctx.roots) {
      for (const { word, theme } of ctx.pool) {
        if (word === root) continue;
        yield label({ name: root + word, strategy: 'compounds', rule: `root ${root} + theme word ${word} (${theme})` });
        yield label({ name: word + root, strategy: 'compounds', rule: `theme word ${word} (${theme}) + root ${root}` });
      }
    }
  } else if (ctx.roots.length >= 2) {
    for (const a of ctx.roots) {
      for (const b of ctx.roots) {
        if (a !== b) yield label({ name: a + b, strategy: 'compounds', rule: `root ${a} + root ${b}` });
      }
    }
  } else if (!ctx.roots.length) {
    const pool = ctx.pool.slice(0, PAIR_POOL_SIZE);
    for (const a of pool) {
      for (const b of pool) {
        if (a.word === b.word) continue;
        yield label({
          name: a.word + b.word,
          strategy: 'compounds',
          rule: `theme word ${a.word} (${a.theme}) + theme word ${b.word} (${b.theme})`,
        });
      }
    }
  }
}

function* syllablesStrategy(ctx: Context): Generator<Raw> {
  const random = mulberry32(ctx.seed);
  const pick = (chars: string) => chars[Math.floor(random() * chars.length)] ?? chars[0]!;
  for (let i = 0; i < ctx.syllableCount; i++) {
    const count = random() < 0.5 ? 2 : 3;
    const patterns: string[] = [];
    let name = '';
    for (let s = 0; s < count; s++) {
      const closed = random() >= 0.6;
      patterns.push(closed ? 'CVC' : 'CV');
      name += pick(CONSONANTS) + pick(VOWELS) + (closed ? pick(CONSONANTS) : '');
    }
    yield label({ name, strategy: 'syllables', rule: `syllables ${patterns.join('-')} seed ${ctx.seed}` });
  }
}

function* mutationsStrategy(ctx: Context): Generator<Raw> {
  for (const base of bases(ctx)) {
    for (const m of mutations(base.word)) {
      yield label({ name: m.value, strategy: 'mutations', rule: `mutation ${m.label} of ${base.describe}` });
    }
  }
}

/**
 * Domain hacks read the whole domain as one word: "bitly" with extension ly gives bit.ly. Words come
 * from roots and the selected themes. Only single-label extensions split cleanly; a multi-label
 * suffix such as co.uk spans a registry boundary, so those hacks are flagged and never valid.
 */
function* hacksStrategy(ctx: Context): Generator<Raw> {
  const words = [
    ...ctx.roots.map((word) => ({ word, describe: `root ${word}` })),
    ...ctx.pool.map(({ word, theme }) => ({ word, describe: `theme word ${word} (${theme})` })),
  ];
  for (const { word, describe } of words) {
    for (const ext of ctx.extensions) {
      const multiLabel = ext.includes('.');
      const ending = multiLabel ? ext.replace(/\./g, '') : ext;
      if (word.length <= ending.length || !word.endsWith(ending)) continue;
      const name = word.slice(0, -ending.length);
      const domain = `${name}.${ext}`;
      yield {
        name: domain,
        domain,
        label: name,
        strategy: 'hacks',
        rule: `hack ${describe} read as ${domain}`,
        notes: name.length <= 2 ? ['one and two character labels are often reserved or premium'] : [],
        boundary: multiLabel
          ? [`registration boundary: ${ext} has more than one label, so this hack spans a registry boundary; review before scanning`]
          : [],
      };
    }
  }
}

const STRATEGIES: Record<GenerationStrategy, (ctx: Context) => Generator<Raw>> = {
  roots: rootsStrategy,
  affixes: affixesStrategy,
  compounds: compoundsStrategy,
  syllables: syllablesStrategy,
  mutations: mutationsStrategy,
  hacks: hacksStrategy,
};

/** Round-robin across strategies so a limited preview still shows every requested strategy. */
function* interleave(generators: Generator<Raw>[]): Generator<Raw> {
  let active = generators;
  while (active.length) {
    const next: Generator<Raw>[] = [];
    for (const gen of active) {
      const step = gen.next();
      if (step.done) continue;
      yield step.value;
      next.push(gen);
    }
    active = next;
  }
}

type Rules = GenerationRequestParsed['rules'];

/**
 * User rules. Exclusion matches when the label, or the whole hack read as one word, equals or
 * contains an excluded term.
 */
function passesRules(raw: Raw, rules: Rules, exclude: string[]): boolean {
  const { label: l } = raw;
  if (l.length < rules.minLength || l.length > rules.maxLength) return false;
  if (!rules.allowDigits && /[0-9]/.test(l)) return false;
  if (!rules.allowHyphens && l.includes('-')) return false;
  const joined = raw.name.replace(/\./g, '');
  return !exclude.some((term) => l.includes(term) || joined.includes(term));
}

@Injectable()
export class GenerationService {
  constructor(@Inject(ThemeLibrary) private readonly library: ThemeLibrary) {}

  themes(): z.infer<typeof GenerationTheme>[] {
    return this.library.all().map((t) => ({ id: t.id, name: t.name, size: t.words.length, sample: t.words.slice(0, 8) }));
  }

  /**
   * Counts: generated is every raw candidate produced (capped at MAX_GENERATED), unique and duplicates
   * split it by name (or domain for hacks). invalid counts unique candidates returned with valid=false
   * (LDH or domain length failures and ambiguous registration boundaries); filtered counts unique
   * LDH-valid candidates removed by the user's rules, which are not returned. expandedChecks is the
   * number of distinct complete domains a scan of the returned valid candidates would check: each
   * label under each extension (at most 253 characters) plus each hack, deduplicated, so the label
   * bit under ly and the hack bit.ly count once.
   *
   * An extension whose labels fail LDH rejects the whole request (400) rather than being dropped
   * silently, so callers never get counts for extensions that could not be scanned.
   */
  preview(request: GenerationRequestParsed): GenerationPreview {
    const { rules } = request;
    if (rules.minLength > rules.maxLength) {
      throw AppError.invalid('rules.minLength must not exceed rules.maxLength', [
        { path: 'body.rules.minLength', message: 'Greater than maxLength' },
      ]);
    }
    const extensions = clean(request.extensions.map((e) => e.replace(/^\./, '')));
    const badExtensions = extensions.flatMap((ext, index) => {
      const issues = ext.split('.').flatMap((part) => suffixLabelIssues(part));
      return issues.length ? [{ path: `body.extensions.${index}`, message: `${ext}: ${issues.join('; ')}` }] : [];
    });
    if (badExtensions.length) throw AppError.invalid('Invalid extensions', badExtensions);
    const ctx: Context = {
      suppliedRoots: normalize(request.roots),
      roots: clean(request.roots),
      prefixes: clean(request.prefixes),
      suffixes: clean(request.suffixes),
      pool: this.library.pool(request.themes.map((t) => t.trim().toLowerCase())),
      extensions,
      seed: request.seed ?? DEFAULT_SEED,
      syllableCount: request.limit,
    };
    const exclude = clean(rules.exclude);
    const strategies = [...new Set(request.strategies)];

    const unique = new Map<string, Raw>();
    let generated = 0;
    for (const raw of interleave(strategies.map((s) => STRATEGIES[s](ctx)))) {
      generated++;
      const key = raw.domain ?? raw.name;
      if (!unique.has(key)) unique.set(key, raw);
      if (generated >= MAX_GENERATED) break;
    }

    let invalid = 0;
    let filtered = 0;
    const kept: GeneratedCandidate[] = [];
    for (const raw of unique.values()) {
      const base = { name: raw.name, domain: raw.domain, strategy: raw.strategy, rule: raw.rule };
      const issues = raw.domain ? domainIssues(raw.label, raw.domain.slice(raw.label.length + 1)) : ldhIssues(raw.label);
      if (issues.length) {
        invalid++;
        kept.push({ ...base, valid: false, issues });
      } else if (!passesRules(raw, rules, exclude)) {
        filtered++;
      } else if (raw.boundary.length) {
        invalid++;
        kept.push({ ...base, valid: false, issues: [...raw.boundary, ...raw.notes] });
      } else {
        kept.push({ ...base, valid: true, issues: raw.notes });
      }
    }

    const candidates = kept.slice(0, request.limit);
    const expanded = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate.valid) continue;
      if (candidate.domain) {
        expanded.add(candidate.domain);
        continue;
      }
      for (const ext of extensions) {
        const domain = `${candidate.name}.${ext}`;
        if (domain.length <= 253) expanded.add(domain);
      }
    }
    const expandedChecks = expanded.size;

    return {
      candidates,
      counts: { generated, unique: unique.size, duplicates: generated - unique.size, invalid, filtered },
      extensions,
      expandedChecks,
    };
  }
}
