import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureOwnerOnlyDir } from './files.js';

export interface LockContent {
  pid: number;
  instanceId: string;
  createdAt: string;

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

  release(): void;
}

export interface LockOptions {
  isAlive?: (pid: number) => boolean;
  bootId?: string | null;

  partialWriteGraceMs?: number;
}


export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}





export function currentBootId(): string | null {
  try {
    if (process.platform === 'linux') return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    if (process.platform === 'darwin') {
      return execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 2000 }).trim() || null;
    }
  } catch {

  }
  return null;
}






export function acquireInstanceLock(lockFile: string, instanceId: string, options: LockOptions = {}): InstanceLock {
  const isAlive = options.isAlive ?? processAlive;
  const bootId = options.bootId === undefined ? currentBootId() : options.bootId;
  const grace = options.partialWriteGraceMs ?? 10_000;
  const content: LockContent = { pid: process.pid, instanceId, createdAt: new Date().toISOString(), bootId };
  ensureOwnerOnlyDir(dirname(lockFile));

  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(lockFile, JSON.stringify(content))) return makeLock(lockFile, content);

    const raw = readSafe(lockFile);
    if (raw === null) continue;
    const holder = parseLock(raw);
    if (!holder) {

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





function removeStale(lockFile: string, inspected: string, grace: number) {
  const marker = `${lockFile}.recover`;
  if (!tryCreate(marker, String(process.pid))) {

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
