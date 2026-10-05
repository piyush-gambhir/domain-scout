import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Creates `dir` (and parents) and restricts it to the current user: mode 0700 on POSIX, an
 * owner-only ACL on Windows (best effort). Existing directories are tightened too.
 */
export function ensureOwnerOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictToOwner(dir, true);
}

/**
 * Atomically writes a file readable only by the current user (0600 on POSIX, owner-only ACL on
 * Windows). The parent directory is created owner-only if missing. Use it for tokens, runtime
 * metadata and the provider credentials file.
 */
export function writeOwnerOnlyFile(path: string, content: string | Uint8Array): void {
  ensureOwnerOnlyDir(dirname(path));
  // Write next to the target and rename so readers never see a partial file.
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    restrictToOwner(tmp, false);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  // rename keeps the temp file's mode; chmod again in case the target pre-existed on Windows.
  restrictToOwner(path, false);
}

/**
 * Restricts an existing path to the current user. POSIX: chmod 0700 (dirs) or 0600 (files).
 * Windows: removes inherited ACEs and grants full control to the current user only via icacls.
 * The Windows branch is best effort and has not been exercised on a Windows host yet.
 */
export function restrictToOwner(path: string, isDirectory: boolean): void {
  if (process.platform !== 'win32') {
    chmodSync(path, isDirectory ? 0o700 : 0o600);
    return;
  }
  try {
    const domain = process.env.USERDOMAIN;
    const user = domain ? `${domain}\\${userInfo().username}` : userInfo().username;
    const grant = isDirectory ? `${user}:(OI)(CI)F` : `${user}:F`;
    // Drop inherited ACEs, then explicit grants to broad groups (Everyone, Authenticated Users, Users)
    // that a pre-existing custom directory might carry.
    execFileSync(
      'icacls',
      [path, '/inheritance:r', '/grant:r', grant, '/remove:g', '*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545'],
      { stdio: 'ignore', windowsHide: true },
    );
  } catch (error) {
    // Not fatal (the default location is per-user LOCALAPPDATA), but never silent.
    process.emitWarning(`Could not restrict ${path} to the current user: ${(error as Error).message}`);
  }
}
