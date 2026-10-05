import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureOwnerOnlyDir } from './files.js';

export interface LockContent {
  pid: number;
  instanceId: string;
  createdAt: string;
  /** Per-boot identity when the OS exposes one; a lock from an earlier boot is stale even if its pid was reused. */
  bootId: string | null;
}

export class LockHeldError extends Error {
  constructor(
    readonly lockFile: string,
    readonly holder: Partial<LockContent> | null,
  ) {
    super(
      holder?.pid
        ? `Another Domain Scout backend (pid ${holder.pid}) is using this data directory (lock ${lockFile})`
        : `The data directory is locked by another Domain Scout backend that is starting (lock ${lockFile})`,
    );
    this.name = 'LockHeldError';
  }
}

export interface InstanceLock {
  readonly path: string;
  readonly content: LockContent;
  /** Removes the lock if it is still ours. Safe to call more than once. */
  release(): void;
}

export interface LockOptions {
  isAlive?: (pid: number) => boolean;
  bootId?: string | null;
  /** Unparseable locks (and recovery markers) younger than this may belong to a process mid-write. */
  partialWriteGraceMs?: number;
}

/** True when a process with `pid` exists (EPERM means it exists but belongs to someone else). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Stable identity of the current boot, independent of wall-clock changes: Linux boot_id, macOS
 * kern.bootsessionuuid. Null elsewhere (Windows), where only process liveness is checked.
 */
export function currentBootId(): string | null {
  try {
    if (process.platform === 'linux') return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    if (process.platform === 'darwin') {
      return execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 2000 }).trim() || null;
    }
  } catch {
    // Unavailable: fall back to liveness only.
  }
  return null;
}

/**
 * Per-data-directory instance lock created with an exclusive open. A lock whose process is gone (or
 * that was written during an earlier boot) is stale and replaced; a live holder raises LockHeldError.
 * Stale-lock removal is serialized through `<lock>.recover` so two starters cannot both replace it.
 */
export function acquireInstanceLock(lockFile: string, instanceId: string, options: LockOptions = {}): InstanceLock {
  const isAlive = options.isAlive ?? processAlive;
  const bootId = options.bootId === undefined ? currentBootId() : options.bootId;
  const grace = options.partialWriteGraceMs ?? 10_000;
  const content: LockContent = { pid: process.pid, instanceId, createdAt: new Date().toISOString(), bootId };
  ensureOwnerOnlyDir(dirname(lockFile));

  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(lockFile, JSON.stringify(content))) return makeLock(lockFile, content);

    const raw = readSafe(lockFile);
    if (raw === null) continue; // Removed between our open and read: try again.
    const holder = parseLock(raw);
    if (!holder) {
      // mtime can be slightly ahead of Date.now(), so a zero grace must skip the check entirely.
      if (grace > 0 && ageMs(lockFile) < grace) throw new LockHeldError(lockFile, null);
    } else if (!isStale(holder, bootId, isAlive)) {
      throw new LockHeldError(lockFile, holder);
    }
    removeStale(lockFile, raw, grace);
  }
  throw new LockHeldError(lockFile, parseLock(readSafe(lockFile) ?? ''));
}

export function readLock(lockFile: string): LockContent | null {
  return parseLock(readSafe(lockFile) ?? '');
}

/**
 * Removes the inspected stale content while holding the recovery marker. A concurrent starter that
 * already replaced the lock is left alone because the content no longer matches.
 */
function removeStale(lockFile: string, inspected: string, grace: number) {
  const marker = `${lockFile}.recover`;
  if (!tryCreate(marker, String(process.pid))) {
    // A recovery marker left by a crashed starter expires; a fresh one means someone is recovering now.
    if (grace > 0 && ageMs(marker) < grace) throw new LockHeldError(lockFile, null);
    rmSync(marker, { force: true });
    if (!tryCreate(marker, String(process.pid))) throw new LockHeldError(lockFile, null);
  }
  try {
    if (readSafe(lockFile) === inspected) rmSync(lockFile, { force: true });
  } finally {
    rmSync(marker, { force: true });
  }
}

function tryCreate(path: string, data: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  return true;
}

function makeLock(path: string, content: LockContent): InstanceLock {
  let released = false;
  return {
    path,
    content,
    release() {
      if (released) return;
      released = true;
      if (readLock(path)?.instanceId === content.instanceId) rmSync(path, { force: true });
    },
  };
}

function isStale(holder: LockContent, bootId: string | null, isAlive: (pid: number) => boolean): boolean {
  if (holder.pid === process.pid) return false;
  if (!isAlive(holder.pid)) return true;
  // The pid is alive, but if it was recorded during another boot it now belongs to some other process.
  return holder.bootId !== null && bootId !== null && holder.bootId !== bootId;
}

function parseLock(raw: string): LockContent | null {
  try {
    const value = JSON.parse(raw) as Partial<LockContent>;
    if (typeof value.pid !== 'number' || typeof value.instanceId !== 'string') return null;
    return {
      pid: value.pid,
      instanceId: value.instanceId,
      createdAt: String(value.createdAt ?? ''),
      bootId: typeof value.bootId === 'string' ? value.bootId : null,
    };
  } catch {
    return null;
  }
}

function readSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function ageMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
