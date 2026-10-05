import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Bundled word lists live in apps/backend/data/themes; this path works from src (tests) and dist. */
export const DEFAULT_THEME_DIR = fileURLToPath(new URL('../../data/themes/', import.meta.url));

export interface Theme {
  id: string;
  name: string;
  words: string[];
}

export interface ThemeWord {
  word: string;
  theme: string;
}

const WORD = /^[a-z]+$/;

/** Local theme word lists, read once from disk. Never fetched from a network source. */
export class ThemeLibrary {
  private loaded: Theme[] | null = null;

  constructor(private readonly dir: string = DEFAULT_THEME_DIR) {}

  all(): Theme[] {
    if (this.loaded) return this.loaded;
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      files = [];
    }
    const themes: Theme[] = [];
    for (const file of files.sort()) {
      try {
        const parsed = JSON.parse(readFileSync(`${this.dir}/${file}`, 'utf8')) as Partial<Theme>;
        if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string' || !Array.isArray(parsed.words)) continue;
        const words = [...new Set(parsed.words.filter((w): w is string => typeof w === 'string' && WORD.test(w)))];
        themes.push({ id: parsed.id, name: parsed.name, words });
      } catch {
        // A malformed bundled file is skipped rather than failing generation.
      }
    }
    this.loaded = themes;
    return themes;
  }

  get(id: string): Theme | undefined {
    return this.all().find((t) => t.id === id);
  }

  /**
   * Words from the selected themes, interleaved across themes so a bounded slice stays varied.
   * Unknown theme ids are skipped. A word shared by two themes keeps the first theme.
   */
  pool(ids: string[]): ThemeWord[] {
    const selected = [...new Set(ids)].map((id) => this.get(id)).filter((t): t is Theme => t !== undefined);
    const out: ThemeWord[] = [];
    const seen = new Set<string>();
    const longest = Math.max(0, ...selected.map((t) => t.words.length));
    for (let i = 0; i < longest; i++) {
      for (const theme of selected) {
        const word = theme.words[i];
        if (word === undefined || seen.has(word)) continue;
        seen.add(word);
        out.push({ word, theme: theme.id });
      }
    }
    return out;
  }
}
