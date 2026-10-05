import { describe, expect, it } from 'vitest';
import { resolveDataDir, runtimePaths } from '../../src/runtime/paths.js';
import { isLoopbackHost, normalizeOrigin, parseBackendArgs, UsageError } from '../../src/runtime/cli.js';
import { hostAllowed } from '../../src/runtime/http.middleware.js';

const base = { env: {}, homedir: '/home/ana', cwd: '/work' };

describe('resolveDataDir', () => {
  it('uses the macOS application support directory', () => {
    expect(resolveDataDir({ ...base, homedir: '/Users/ana', platform: 'darwin' })).toBe(
      '/Users/ana/Library/Application Support/Domain Scout',
    );
  });

  it('uses LOCALAPPDATA on Windows, falling back to the profile', () => {
    expect(
      resolveDataDir({ ...base, homedir: 'C:\\Users\\ana', platform: 'win32', env: { LOCALAPPDATA: 'D:\\Local' } }),
    ).toBe('D:\\Local\\Domain Scout');
    expect(resolveDataDir({ ...base, homedir: 'C:\\Users\\ana', platform: 'win32' })).toBe(
      'C:\\Users\\ana\\AppData\\Local\\Domain Scout',
    );
  });

  it('uses XDG_DATA_HOME on Linux only when absolute', () => {
    expect(resolveDataDir({ ...base, platform: 'linux', env: { XDG_DATA_HOME: '/data/xdg' } })).toBe('/data/xdg/domain-scout');
    expect(resolveDataDir({ ...base, platform: 'linux', env: { XDG_DATA_HOME: 'relative/xdg' } })).toBe(
      '/home/ana/.local/share/domain-scout',
    );
    expect(resolveDataDir({ ...base, platform: 'linux' })).toBe('/home/ana/.local/share/domain-scout');
  });

  it('prefers the flag, then DOMAIN_SCOUT_DATA_DIR, ignoring empty values', () => {
    const env = { DOMAIN_SCOUT_DATA_DIR: '/env/dir' };
    expect(resolveDataDir({ ...base, platform: 'linux', env, flag: '/flag/dir' })).toBe('/flag/dir');
    expect(resolveDataDir({ ...base, platform: 'linux', env })).toBe('/env/dir');
    expect(resolveDataDir({ ...base, platform: 'linux', env: { DOMAIN_SCOUT_DATA_DIR: '  ' }, flag: '' })).toBe(
      '/home/ana/.local/share/domain-scout',
    );
    expect(resolveDataDir({ ...base, platform: 'linux', flag: 'rel' })).toBe('/work/rel');
  });

  it('places runtime files under <dataDir>/run and the lock in the data directory', () => {
    const paths = runtimePaths('/d', 'linux');
    expect(paths).toMatchObject({
      runtimeDir: '/d/run',
      lockFile: '/d/backend.lock',
      tokenFile: '/d/run/api-token',
      runtimeFile: '/d/run/backend.json',
      artifactsDir: '/d/artifacts',
    });
  });
});

describe('parseBackendArgs', () => {
  it('applies defaults', () => {
    const args = parseBackendArgs(['--data-dir', '/tmp/x'], {}, 'linux');
    expect(args).toEqual({
      dataDir: '/tmp/x',
      host: '127.0.0.1',
      port: 4317,
      webOrigins: ['http://127.0.0.1:3000', 'http://localhost:3000'],
    });
  });

  it('takes the port from the flag before DOMAIN_SCOUT_PORT', () => {
    expect(parseBackendArgs(['--data-dir', '/x'], { DOMAIN_SCOUT_PORT: '5000' }, 'linux').port).toBe(5000);
    expect(parseBackendArgs(['--data-dir', '/x', '--port', '6000'], { DOMAIN_SCOUT_PORT: '5000' }, 'linux').port).toBe(6000);
  });

  it('accepts repeated web origins in canonical form', () => {
    const args = parseBackendArgs(['--data-dir', '/x', '--web-origin', 'http://127.0.0.1:3100/', '--web-origin', 'http://LOCALHOST:3100'], {}, 'linux');
    expect(args.webOrigins).toEqual(['http://127.0.0.1:3100', 'http://localhost:3100']);
  });

  it('rejects invalid usage', () => {
    expect(() => parseBackendArgs(['--port', 'abc'], {}, 'linux')).toThrow(UsageError);
    expect(() => parseBackendArgs(['--port', '70000'], {}, 'linux')).toThrow(UsageError);
    expect(() => parseBackendArgs(['--bogus'], {}, 'linux')).toThrow(UsageError);
    expect(() => parseBackendArgs(['--web-origin', 'http://x/path'], {}, 'linux')).toThrow(UsageError);
    expect(() => parseBackendArgs(['--host', '0.0.0.0'], {}, 'linux')).toThrow(/loopback/);
    expect(() => parseBackendArgs(['--host', '192.168.1.5'], {}, 'linux')).toThrow(UsageError);
    expect(parseBackendArgs(['--data-dir', '/x', '--host', '::1'], {}, 'linux').host).toBe('::1');
  });

  it('normalizes origins and recognizes loopback hosts', () => {
    expect(normalizeOrigin('https://example.test:443/')).toBe('https://example.test');
    expect(normalizeOrigin('file:///tmp')).toBeNull();
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });
});

describe('hostAllowed', () => {
  it('accepts loopback names on the connection port only', () => {
    expect(hostAllowed('127.0.0.1:4317', 4317, null)).toBe(true);
    expect(hostAllowed('localhost:4317', 4317, null)).toBe(true);
    expect(hostAllowed('[::1]:4317', 4317, null)).toBe(true);
    expect(hostAllowed('LOCALHOST:4317', 4317, null)).toBe(true);
    expect(hostAllowed('127.0.0.1:4318', 4317, null)).toBe(false);
    expect(hostAllowed('127.0.0.1', 4317, null)).toBe(false);
    expect(hostAllowed('evil.example:4317', 4317, null)).toBe(false);
    expect(hostAllowed('127.0.0.1.evil.example:4317', 4317, null)).toBe(false);
    expect(hostAllowed(undefined, 4317, null)).toBe(false);
    expect(hostAllowed('127.0.0.2:4317', 4317, '127.0.0.2')).toBe(true);
  });
});
