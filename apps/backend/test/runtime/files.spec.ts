import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureOwnerOnlyDir, writeOwnerOnlyFile } from '../../src/runtime/files.js';
import { acquireInstanceLock, LockHeldError, processAlive, readLock } from '../../src/runtime/lock.js';
import { readRuntimeFile, removeRuntimeFile, writeRuntimeFile } from '../../src/runtime/runtime-file.js';
import { loadOrCreateApiToken } from '../../src/runtime/token.js';

const posix = process.platform !== 'win32';
const mode = (path: string) => statSync(path).mode & 0o777;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ds-runtime-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('owner-only files', () => {
  it.runIf(posix)('creates directories 0700 and files 0600, tightening existing ones', () => {
    const sub = join(dir, 'a', 'run');
    ensureOwnerOnlyDir(sub);
    expect(mode(sub)).toBe(0o700);
    const file = join(sub, 'secret');
    writeFileSync(file, 'old', { mode: 0o644 });
    writeOwnerOnlyFile(file, 'new');
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(mode(file)).toBe(0o600);
  });
});

describe('API token', () => {
  it('is created once (43 base64url chars, 0600) and reused across restarts', () => {
    const file = join(dir, 'run', 'api-token');
    const first = loadOrCreateApiToken(file);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (posix) expect(mode(file)).toBe(0o600);
    expect(loadOrCreateApiToken(file)).toBe(first);
  });

  it.runIf(posix)('re-tightens loose permissions and replaces a malformed token', () => {
    const file = join(dir, 'api-token');
    const token = loadOrCreateApiToken(file);
    chmodSync(file, 0o644);
    expect(loadOrCreateApiToken(file)).toBe(token);
    expect(mode(file)).toBe(0o600);
    writeFileSync(file, 'short');
    expect(loadOrCreateApiToken(file)).not.toBe(token);
  });
});

describe('runtime file', () => {
  it('is owner-only and removed only by the instance that wrote it', () => {
    const file = join(dir, 'run', 'backend.json');
    const info = writeRuntimeFile(file, {
      url: 'http://127.0.0.1:4317',
      pid: process.pid,
      instanceId: 'a',
      version: '1.0.0',
      startedAt: '2026-10-05T12:00:00.000Z',
      dataDir: dir,
    });
    expect(readRuntimeFile(file)).toEqual(info);
    expect(info).toMatchObject({ protocolVersion: 1, contractVersion: expect.any(String) });
    if (posix) expect(mode(file)).toBe(0o600);
    removeRuntimeFile(file, 'b');
    expect(existsSync(file)).toBe(true);
    removeRuntimeFile(file, 'a');
    expect(existsSync(file)).toBe(false);
  });
});

describe('instance lock', () => {
  const lockFile = () => join(dir, 'backend.lock');
  const writeLock = (content: object) => writeFileSync(lockFile(), JSON.stringify(content));

  it('is exclusive while held and released by its owner', () => {
    const lock = acquireInstanceLock(lockFile(), 'first');
    expect(readLock(lockFile())).toMatchObject({ pid: process.pid, instanceId: 'first' });
    if (posix) expect(mode(lockFile())).toBe(0o600);
    expect(() => acquireInstanceLock(lockFile(), 'second')).toThrow(LockHeldError);
    lock.release();
    expect(existsSync(lockFile())).toBe(false);
    acquireInstanceLock(lockFile(), 'second').release();
  });

  it('refuses a live holder and replaces a dead one', () => {
    writeLock({ pid: 424242, instanceId: 'other', bootId: 'boot-1' });
    expect(() => acquireInstanceLock(lockFile(), 'me', { isAlive: () => true, bootId: 'boot-1' })).toThrow(/pid 424242/);
    const lock = acquireInstanceLock(lockFile(), 'me', { isAlive: () => false, bootId: 'boot-1' });
    expect(readLock(lockFile())?.instanceId).toBe('me');
    lock.release();
  });

  it('treats a lock from another boot as stale even if its pid is reused, but never on clock changes alone', () => {
    writeLock({ pid: 424242, instanceId: 'old', bootId: 'boot-0', createdAt: '2020-01-01T00:00:00.000Z' });
    const lock = acquireInstanceLock(lockFile(), 'me', { isAlive: () => true, bootId: 'boot-1' });
    expect(readLock(lockFile())?.instanceId).toBe('me');
    lock.release();
    // Same boot (or no boot identity available): a live pid always holds the lock.
    writeLock({ pid: 424242, instanceId: 'live', bootId: 'boot-1', createdAt: '2099-01-01T00:00:00.000Z' });
    expect(() => acquireInstanceLock(lockFile(), 'me', { isAlive: () => true, bootId: 'boot-1' })).toThrow(LockHeldError);
    expect(() => acquireInstanceLock(lockFile(), 'me', { isAlive: () => true, bootId: null })).toThrow(LockHeldError);
  });

  it('serializes stale-lock recovery through a marker file', () => {
    writeLock({ pid: 424242, instanceId: 'dead', bootId: null });
    writeFileSync(`${lockFile()}.recover`, '1');
    // Another starter is recovering right now: do not race it.
    expect(() => acquireInstanceLock(lockFile(), 'me', { isAlive: () => false })).toThrow(LockHeldError);
    expect(readLock(lockFile())?.instanceId).toBe('dead');
    // A marker abandoned by a crashed starter expires.
    const lock = acquireInstanceLock(lockFile(), 'me', { isAlive: () => false, partialWriteGraceMs: 0 });
    expect(readLock(lockFile())?.instanceId).toBe('me');
    expect(existsSync(`${lockFile()}.recover`)).toBe(false);
    lock.release();
  });

  it('waits out a possibly half-written lock, then replaces it', () => {
    writeFileSync(lockFile(), '');
    expect(() => acquireInstanceLock(lockFile(), 'me')).toThrow(LockHeldError);
    acquireInstanceLock(lockFile(), 'me', { partialWriteGraceMs: 0 }).release();
  });

  it('does not remove a lock that another instance has since taken over', () => {
    const lock = acquireInstanceLock(lockFile(), 'me');
    writeLock({ pid: process.pid, instanceId: 'successor', bootId: null });
    lock.release();
    expect(readLock(lockFile())?.instanceId).toBe('successor');
  });

  it('detects real process liveness', async () => {
    expect(processAlive(process.pid)).toBe(true);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    await new Promise((resolve) => child.once('spawn', resolve));
    expect(processAlive(child.pid!)).toBe(true);
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    expect(processAlive(child.pid!)).toBe(false);
  });
});
