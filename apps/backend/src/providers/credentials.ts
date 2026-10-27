import { Inject, Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CredentialStorage } from '@domain-scout/contracts';
import { APP_CONFIG, type AppConfig } from '../core/config.js';
import { AppError } from '../core/errors.js';
import { writeOwnerOnlyFile } from '../runtime/files.js';
import type { ProviderManifest } from './manifest.js';

/** Environment source for credentials; a token so tests supply their own variables. */
export const CREDENTIAL_ENV = Symbol('CREDENTIAL_ENV');
export type CredentialEnv = Record<string, string | undefined>;

export const CREDENTIALS_FILE = 'credentials.json';

interface CredentialFileShape {
  version: 1;
  providers: Record<string, { values: Record<string, string>; savedAt: string }>;
}

export interface ResolvedCredentials {
  /** Values from the winning source; null when nothing is configured. Never leaves the backend. */
  values: Record<string, string> | null;
  storage: CredentialStorage | null;
  storageLocation: string | null;
  fields: { key: string; set: boolean }[];
  /** All required fields are set in the winning source. */
  configured: boolean;
}

/**
 * Provider credentials from three sources, highest precedence first:
 *   session  kept in memory until the backend stops (explicit console/CLI choice)
 *   env      DOMAIN_SCOUT_<PROVIDER>_<FIELD> variables
 *   file     <dataDir>/credentials.json, owner-only (0600 / owner ACL), outside SQLite and the repo
 * One source wins as a whole; fields are never mixed across sources. Values are never returned by
 * the API, logged, exported or written to SQLite.
 */
@Injectable()
export class CredentialStore {
  private readonly session = new Map<string, Record<string, string>>();
  readonly filePath: string;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(CREDENTIAL_ENV) private readonly env: CredentialEnv,
  ) {
    this.filePath = join(config.dataDir, CREDENTIALS_FILE);
  }

  /** Providers with session-only credentials, which are lost when the backend stops. */
  sessionProviders(): string[] {
    return [...this.session.keys()];
  }

  resolve(manifest: ProviderManifest): ResolvedCredentials {
    const fieldsOf = (values: Record<string, string> | null) =>
      manifest.credentialFields.map((f) => ({ key: f.key, set: Boolean(values?.[f.key]) }));
    const candidates: [CredentialStorage, Record<string, string> | null, string | null][] = [
      ['session', this.session.get(manifest.id) ?? null, null],
      ['env', this.fromEnv(manifest), null],
      ['file', this.readFile().providers[manifest.id]?.values ?? null, this.filePath],
    ];
    for (const [storage, values, location] of candidates) {
      if (!values || !manifest.credentialFields.some((f) => values[f.key])) continue;
      const configured = manifest.credentialFields.every((f) => !f.required || Boolean(values[f.key]));
      return { values, storage, storageLocation: location, fields: fieldsOf(values), configured };
    }
    return { values: null, storage: null, storageLocation: null, fields: fieldsOf(null), configured: false };
  }

  /** Saves a complete credential set to one storage. Saving to the file clears a session copy so it takes effect. */
  save(manifest: ProviderManifest, values: Record<string, string>, storage: 'session' | 'file', now: string) {
    const allowed = new Set(manifest.credentialFields.map((f) => f.key));
    if (allowed.size === 0) throw new AppError('unsupported', `${manifest.name} has no account integration to configure`);
    const unknown = Object.keys(values).filter((k) => !allowed.has(k));
    if (unknown.length) {
      throw AppError.invalid(
        `Unknown credential fields for ${manifest.name}`,
        unknown.map((k) => ({ path: `body.values.${k}`, message: `Expected one of: ${[...allowed].join(', ')}` })),
      );
    }
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) if (v.trim()) clean[k] = v.trim();
    const missing = manifest.credentialFields.filter((f) => f.required && !clean[f.key]);
    if (missing.length) {
      throw AppError.invalid(
        `Missing required credential fields for ${manifest.name}`,
        missing.map((f) => ({ path: `body.values.${f.key}`, message: `${f.label} is required` })),
      );
    }
    if (storage === 'session') {
      this.session.set(manifest.id, clean);
      return;
    }
    this.session.delete(manifest.id);
    const file = this.readFile();
    file.providers[manifest.id] = { values: clean, savedAt: now };
    this.writeFile(file);
  }

  /** Disconnect: removes session and file copies. Environment variables cannot be removed from here. */
  remove(manifest: ProviderManifest) {
    this.session.delete(manifest.id);
    const file = this.readFile();
    if (file.providers[manifest.id]) {
      delete file.providers[manifest.id];
      this.writeFile(file);
    }
  }

  private fromEnv(manifest: ProviderManifest): Record<string, string> | null {
    const values: Record<string, string> = {};
    for (const f of manifest.credentialFields) {
      const value = this.env[f.envVar]?.trim();
      if (value) values[f.key] = value;
    }
    return Object.keys(values).length ? values : null;
  }

  private readFile(): CredentialFileShape {
    if (!existsSync(this.filePath)) return { version: 1, providers: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<CredentialFileShape>;
      return { version: 1, providers: parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {} };
    } catch {
      // A corrupt file is treated as empty; it is replaced on the next explicit save.
      return { version: 1, providers: {} };
    }
  }

  private writeFile(file: CredentialFileShape) {
    writeOwnerOnlyFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }
}
