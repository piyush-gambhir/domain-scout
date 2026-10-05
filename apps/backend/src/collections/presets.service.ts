import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ExtensionPreset } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { InputPreviewer } from '../core/ports.js';
import { Database, json } from '../storage/database.js';

/**
 * Built-in presets come from the registry module (InputPreviewer.presets(), bundled data) and use
 * plain slug ids. Saved presets live in extension_presets and use UUIDs, so the id spaces never
 * collide. This list is used only when the registry module is not loaded.
 */
const FALLBACK_PRESETS: ExtensionPreset[] = [
  { id: 'popular', name: 'Popular', extensions: ['com', 'net', 'org', 'io', 'ai', 'app', 'dev'], builtIn: true, createdAt: null },
  { id: 'tech', name: 'Tech', extensions: ['io', 'dev', 'app', 'ai', 'tech'], builtIn: true, createdAt: null },
];

interface PresetRow {
  id: string;
  name: string;
  extensions_json: string;
  created_at: string;
}

@Injectable()
export class PresetsService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    @Optional() private readonly previewer?: InputPreviewer,
  ) {}

  /** Built-in presets first, then saved presets in creation order. */
  list(): ExtensionPreset[] {
    const saved = this.db
      .all<PresetRow>('SELECT * FROM extension_presets ORDER BY created_at, name')
      .map(toPreset);
    return [...this.builtIn(), ...saved];
  }

  create(body: { name: string; extensions: string[] }): ExtensionPreset {
    const id = randomUUID();
    const extensions = [...new Set(body.extensions.map((e) => e.trim().toLowerCase().replace(/^\.+/, '')))];
    this.db.run('INSERT INTO extension_presets (id, name, extensions_json, created_at) VALUES (?, ?, ?, ?)', [
      id,
      body.name,
      json.stringify(extensions),
      this.clock.iso(),
    ]);
    return toPreset(this.db.get<PresetRow>('SELECT * FROM extension_presets WHERE id = ?', [id])!);
  }

  delete(id: string) {
    if (this.builtIn().some((preset) => preset.id === id)) {
      throw AppError.conflict('Built-in presets cannot be deleted');
    }
    const { changes } = this.db.run('DELETE FROM extension_presets WHERE id = ?', [id]);
    if (changes === 0) throw AppError.notFound('Extension preset');
  }

  private builtIn(): ExtensionPreset[] {
    const presets = this.previewer ? this.previewer.presets() : FALLBACK_PRESETS;
    return presets.map((preset) => ({ ...preset, builtIn: true, createdAt: null }));
  }
}

function toPreset(row: PresetRow): ExtensionPreset {
  return {
    id: row.id,
    name: row.name,
    extensions: json.parse<string[]>(row.extensions_json, []),
    builtIn: false,
    createdAt: row.created_at,
  };
}
