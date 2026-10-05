import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { DEFAULT_HOST, DEFAULT_PORT, DEFAULT_WEB_ORIGINS, resolveDataDir } from './paths.js';

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
}

export const USAGE = `Usage: domain-scout-backend [--data-dir DIR] [--host HOST] [--port PORT] [--web-origin ORIGIN]...

  --data-dir    Data directory (default: DOMAIN_SCOUT_DATA_DIR or the per-user application data directory)
  --host        Loopback address to bind: 127.x.x.x, ::1 or localhost (default ${DEFAULT_HOST})
  --port        Port (default DOMAIN_SCOUT_PORT or ${DEFAULT_PORT})
  --web-origin  Browser origin allowed to use sessions; repeatable (default ${DEFAULT_WEB_ORIGINS.join(', ')})`;

/** Parses backend flags. Precedence: flag, then environment, then defaults. Throws UsageError. */
export function parseBackendArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): BackendArgs {
  let values: { 'data-dir'?: string; host?: string; port?: string; 'web-origin'?: string[] };
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        'data-dir': { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
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

  const webOrigins = values['web-origin'] ?? DEFAULT_WEB_ORIGINS;
  for (const origin of webOrigins) {
    if (normalizeOrigin(origin) === null) throw new UsageError(`Invalid --web-origin "${origin}": expected scheme://host[:port]`);
  }

  return {
    dataDir: resolveDataDir({ flag: values['data-dir'], env, platform, homedir: homedir(), cwd: process.cwd() }),
    host,
    port: Number(portText),
    webOrigins: webOrigins.map((origin) => normalizeOrigin(origin)!),
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
