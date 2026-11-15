import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';





export function ensureOwnerOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictToOwner(dir, true);
}






export function writeOwnerOnlyFile(path: string, content: string | Uint8Array): void {
  ensureOwnerOnlyDir(dirname(path));

  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    restrictToOwner(tmp, false);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }

  restrictToOwner(path, false);
}






export function restrictToOwner(path: string, isDirectory: boolean): void {
  if (process.platform !== 'win32') {
    chmodSync(path, isDirectory ? 0o700 : 0o600);
    return;
  }
  try {
    const domain = process.env.USERDOMAIN;
    const user = domain ? `${domain}\\${userInfo().username}` : userInfo().username;
    const grant = isDirectory ? `${user}:(OI)(CI)F` : `${user}:F`;


    execFileSync(
      'icacls',
      [path, '/inheritance:r', '/grant:r', grant, '/remove:g', '*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545'],
      { stdio: 'ignore', windowsHide: true },
    );
  } catch (error) {

    process.emitWarning(`Could not restrict ${path} to the current user: ${(error as Error).message}`);
  }
}
