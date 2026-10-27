import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { DEFAULT_HOST, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_PORT, DEFAULT_WEB_ORIGINS, resolveDataDir } from './paths.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface BackendArgs {
  dataDir: string;
  host: string;
  port: number;
  webOrigins: string[];
  /** 0 disables stopping when idle. */
  idleTimeoutMs: number;
}

export const USAGE = `Usage: domain-scout-backend [--data-dir DIR] [--host HOST] [--port PORT] [--idle-timeout SECONDS] [--web-origin ORIGIN]...

  --data-dir    Data directory (default: DOMAIN_SCOUT_DATA_DIR or the per-user application data directory)
  --host        Loopback address to bind: 127.x.x.x, ::1 or localhost (default ${DEFAULT_HOST})
  --port        Port (default DOMAIN_SCOUT_PORT or ${DEFAULT_PORT})
  --idle-timeout  Stop after this many seconds with no requests, unfinished jobs, active watches,
                  session-only credentials or running UI server; 0 never stops
                  (default DOMAIN_SCOUT_IDLE_TIMEOUT or ${DEFAULT_IDLE_TIMEOUT_MS / 1000})
  --web-origin  Browser origin allowed to use sessions; repeatable (default ${DEFAULT_WEB_ORIGINS.join(', ')})`;

/** Parses backend flags. Precedence: flag, then environment, then defaults. Throws UsageError. */
export function parseBackendArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): BackendArgs {
  let values: { 'data-dir'?: string; host?: string; port?: string; 'idle-timeout'?: string; 'web-origin'?: string[] };
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        'data-dir': { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
        'idle-timeout': { type: 'string' },
        'web-origin': { type: 'string', multiple: true },
      },
    }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }

  const portText = values.port ?? nonEmpty(env.DOMAIN_SCOUT_PORT) ?? String(DEFAULT_PORT);
  if (!/^\d+$/.test(portText) || Number(portText) > 65_535) {
    throw new UsageError(`Invalid port "${portText}": expected an integer from 0 to 65535`);
  }
  const host = values.host ?? DEFAULT_HOST;
  // The API is local-only; a non-loopback bind would expose it beyond this machine.
  if (!isLoopbackHost(host)) throw new UsageError(`Invalid --host "${host}": only loopback addresses are allowed`);

  const idleText = values['idle-timeout'] ?? nonEmpty(env.DOMAIN_SCOUT_IDLE_TIMEOUT) ?? String(DEFAULT_IDLE_TIMEOUT_MS / 1000);
  if (!/^\d+$/.test(idleText)) throw new UsageError(`Invalid idle timeout "${idleText}": expected whole seconds, 0 to never stop`);

  const webOrigins = values['web-origin'] ?? DEFAULT_WEB_ORIGINS;
  for (const origin of webOrigins) {
    if (normalizeOrigin(origin) === null) throw new UsageError(`Invalid --web-origin "${origin}": expected scheme://host[:port]`);
  }

  return {
    dataDir: resolveDataDir({ flag: values['data-dir'], env, platform, homedir: homedir(), cwd: process.cwd() }),
    host,
    port: Number(portText),
    webOrigins: webOrigins.map((origin) => normalizeOrigin(origin)!),
    idleTimeoutMs: Number(idleText) * 1000,
  };
}

/** Canonical `scheme://host[:port]` form (what browsers send in Origin), or null when invalid. */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.pathname !== '/' || url.search || url.hash || url.username) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Loopback addresses are the only ones the backend is designed to bind. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() !== '' ? value.trim() : undefined;
}
