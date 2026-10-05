import { readFileSync, rmSync } from 'node:fs';
import { CONTRACT_VERSION, PROTOCOL_VERSION } from '@domain-scout/contracts';
import { writeOwnerOnlyFile } from './files.js';

/** Contents of `<dataDir>/run/backend.json`; clients verify instanceId/protocolVersion via /health. */
export interface BackendRuntimeInfo {
  url: string;
  pid: number;
  instanceId: string;
  protocolVersion: number;
  contractVersion: string;
  version: string;
  startedAt: string;
  dataDir: string;
}

export function backendUrl(host: string, port: number): string {
  const literal = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${literal}:${port}`;
}

export function writeRuntimeFile(
  path: string,
  info: Omit<BackendRuntimeInfo, 'protocolVersion' | 'contractVersion'>,
): BackendRuntimeInfo {
  const full: BackendRuntimeInfo = { ...info, protocolVersion: PROTOCOL_VERSION, contractVersion: CONTRACT_VERSION };
  writeOwnerOnlyFile(path, `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

export function readRuntimeFile(path: string): BackendRuntimeInfo | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BackendRuntimeInfo;
  } catch {
    return null;
  }
}

/** Removes the runtime file only when it still describes this instance. */
export function removeRuntimeFile(path: string, instanceId: string): void {
  if (readRuntimeFile(path)?.instanceId === instanceId) rmSync(path, { force: true });
}
