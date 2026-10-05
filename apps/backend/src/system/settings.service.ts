import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_SETTINGS, Settings, type Settings as SettingsShape } from '@domain-scout/contracts';
import type { z } from 'zod';
import { SettingsPatch } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { Database, json } from '../storage/database.js';

const KEY = 'app';

/** Ordinary preferences stored as one JSON document. Secrets never go here. */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger('Settings');
  private cache: SettingsShape | null = null;
  private readonly listeners = new Set<(settings: SettingsShape) => void>();

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

  /**
   * Validates, persists and caches a partial update. Runs in its own transaction and must not be
   * called inside another one: an outer rollback would leave the cache and listeners holding
   * settings that were never committed.
   */
  patch(patch: z.output<typeof SettingsPatch>): SettingsShape {
    if (this.db.inTransaction) throw new Error('SettingsService.patch must not run inside another transaction');
    const next = Settings.parse(mergeSettings(this.get(), patch as Partial<SettingsShape>));
    this.db.transaction(() =>
      this.db.run(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        [KEY, json.stringify(next), this.clock.iso()],
      ),
    );
    this.cache = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (error) {
        this.logger.error(`Settings listener failed: ${(error as Error).message}`);
      }
    }
    return next;
  }

  /** Called after every committed patch (e.g. the jobs engine resizing its budgets). Returns an unsubscribe function. */
  onChange(listener: (settings: SettingsShape) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
