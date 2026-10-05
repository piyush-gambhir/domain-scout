'use client';

import { newIdempotencyKey } from './api';
import { readJson, writeJson } from './storage';

/**
 * Hand-off of scan input between pages (history, discover, shortlists) without running anything.
 * Callers stash the input and navigate to the returned URL; /scan prefills its form from it.
 * /scan also accepts ?job=<id> (restore a past job's input) and ?criteria=<id> (saved criteria).
 */
export interface ScanInputRestore {
  text: string;
  extensions: string[];
  format?: 'auto' | 'lines' | 'csv';
  csvColumn?: string;
  label?: string;
}

const PREFIX = 'ds.restore.';

export function stashScanInput(input: ScanInputRestore): string {
  const key = newIdempotencyKey().slice(0, 8);
  writeJson('session', PREFIX + key, input);
  return `/scan?restore=${key}`;
}

export function takeScanInput(key: string): ScanInputRestore | null {
  const value = readJson<ScanInputRestore>('session', PREFIX + key);
  writeJson('session', PREFIX + key, null);
  return value;
}
