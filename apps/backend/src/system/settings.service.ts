import { Injectable } from '@nestjs/common';
import { DEFAULT_SETTINGS, Settings, type Settings as SettingsShape } from '@domain-scout/contracts';
import type { z } from 'zod';
import { SettingsPatch } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { Database, json } from '../storage/database.js';

const KEY = 'app';

/** Ordinary preferences stored as one JSON document. Secrets never go here. */
@Injectable()
export class SettingsService {
  private cache: SettingsShape | null = null;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  get(): SettingsShape {
    if (this.cache) return this.cache;
    const row = this.db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', [KEY]);
    const stored = json.parse<Partial<SettingsShape>>(row?.value_json, {});
    const merged = mergeSettings(DEFAULT_SETTINGS, stored);
    const parsed = Settings.safeParse(merged);
    this.cache = parsed.success ? parsed.data : DEFAULT_SETTINGS;
    return this.cache;
  }

  patch(patch: z.output<typeof SettingsPatch>): SettingsShape {
    const next = Settings.parse(mergeSettings(this.get(), patch as Partial<SettingsShape>));
    this.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [KEY, json.stringify(next), this.clock.iso()],
    );
    this.cache = next;
    return next;
  }
}

function mergeSettings(base: SettingsShape, patch: Partial<SettingsShape>): SettingsShape {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = (base as Record<string, unknown>)[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object'
        ? { ...current, ...value }
        : value;
  }
  return out as SettingsShape;
}
