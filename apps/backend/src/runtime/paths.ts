import { posix, win32 } from 'node:path';

export const APP_DIR_NAME = 'Domain Scout';
export const APP_DIR_NAME_XDG = 'domain-scout';
export const DEFAULT_PORT = 4317;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_WEB_ORIGINS = ['http://127.0.0.1:3000', 'http://localhost:3000'];
/** Idle period before the backend stops itself (--idle-timeout or DOMAIN_SCOUT_IDLE_TIMEOUT overrides it). */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

export interface DataDirInput {
  /** `--data-dir` flag value. */
  flag?: string | undefined;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir: string;
  cwd: string;
}

/**
 * Data directory per the local runtime protocol (shared with the Go CLI and web):
 * `--data-dir`, else DOMAIN_SCOUT_DATA_DIR, else the platform's per-user application data directory.
 * Pure so every platform branch is testable on any OS.
 */
export function resolveDataDir(input: DataDirInput): string {
  const path = input.platform === 'win32' ? win32 : posix;
  const explicit = nonEmpty(input.flag) ?? nonEmpty(input.env.DOMAIN_SCOUT_DATA_DIR);
  if (explicit) return path.resolve(input.cwd, explicit);
  if (input.platform === 'darwin') return path.join(input.homedir, 'Library', 'Application Support', APP_DIR_NAME);
  if (input.platform === 'win32') {
    const base = nonEmpty(input.env.LOCALAPPDATA) ?? path.join(input.homedir, 'AppData', 'Local');
    return path.join(base, APP_DIR_NAME);
  }
  // XDG requires an absolute path; relative values must be ignored.
  const xdg = nonEmpty(input.env.XDG_DATA_HOME);
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(input.homedir, '.local', 'share');
  return path.join(base, APP_DIR_NAME_XDG);
}

export interface RuntimePaths {
  dataDir: string;
  /** Transient runtime metadata, mode 0700. */
  runtimeDir: string;
  lockFile: string;
  tokenFile: string;
  runtimeFile: string;
  webRuntimeFile: string;
  /** Export and snapshot files. Scoped deletion never touches anything outside this directory. */
  artifactsDir: string;
}

export function runtimePaths(dataDir: string, platform: NodeJS.Platform = process.platform): RuntimePaths {
  const path = platform === 'win32' ? win32 : posix;
  const runtimeDir = path.join(dataDir, 'run');
  return {
    dataDir,
    runtimeDir,
    lockFile: path.join(dataDir, 'backend.lock'),
    tokenFile: path.join(runtimeDir, 'api-token'),
    runtimeFile: path.join(runtimeDir, 'backend.json'),
    webRuntimeFile: path.join(runtimeDir, 'web.json'),
    artifactsDir: path.join(dataDir, 'artifacts'),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() !== '' ? value : undefined;
}
