import { readFileSync } from 'node:fs';
import { cap, unsupported, type ProviderManifest } from './manifest.js';
import { REGISTRAR_MANIFESTS } from './manifests.js';

/** Dated snapshot of a registry-published registrar list (data/providers/<file>.json). */
export interface DirectorySnapshot {
  source: string;
  publisher: string;
  fetchedAt: string;
  suffixes: string[];
  notes: string;
  registrars: { id: string; name: string; website: string; onlinePayment: boolean; providerId?: string }[];
}

const SNAPSHOTS = ['register-si.json'];

/** Resolves data/providers from both src/providers (dev, tests) and dist/providers (build). */
function readSnapshot(file: string): DirectorySnapshot {
  const url = new URL(`../../data/providers/${file}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as DirectorySnapshot;
}

export function loadDirectorySnapshots(): DirectorySnapshot[] {
  return SNAPSHOTS.map(readSnapshot);
}

function directoryManifest(snapshot: DirectorySnapshot, entry: DirectorySnapshot['registrars'][number]): ProviderManifest {
  const linkNote = `Registrar website as published by ${snapshot.publisher} (${snapshot.fetchedAt.slice(0, 10)}); no exact-name search template is verified, so the link opens the website.`;
  return {
    id: entry.id,
    name: entry.name,
    kind: 'directory',
    website: entry.website,
    setupUrl: null,
    apiHost: null,
    docsUrl: snapshot.source,
    credentialFields: [],
    accountRequirements: [],
    rateLimits: null,
    purchaseLink: { template: entry.website, kind: 'search', source: snapshot.source, verifiedAt: null },
    knownSuffixes: { suffixes: snapshot.suffixes, source: snapshot.source },
    capabilities: {
      purchaseLink: cap('documented', false, snapshot.source, linkNote, null),
      catalog: unsupported('Directory entry: no price source.'),
      exactCheck: unsupported('Directory entry: no availability interface.'),
      quote: unsupported('Directory entry: no quote interface.'),
      transfer: unsupported('Directory entry: no transfer interface.'),
      aftermarket: unsupported('Directory entry: no aftermarket interface.'),
    },
  };
}

/**
 * The nine registrars followed by registry-published directory entries. A directory entry that is
 * one of the nine adds its suffixes to that provider instead of appearing twice.
 */
export function buildManifests(snapshots: DirectorySnapshot[] = loadDirectorySnapshots()): ProviderManifest[] {
  const registrars = REGISTRAR_MANIFESTS.map((m) => ({ ...m }));
  const byId = new Map(registrars.map((m) => [m.id, m]));
  const directory: ProviderManifest[] = [];
  for (const snapshot of snapshots) {
    for (const entry of snapshot.registrars) {
      const known = entry.providerId ? byId.get(entry.providerId) : undefined;
      if (known) {
        const suffixes = new Set([...(known.knownSuffixes?.suffixes ?? []), ...snapshot.suffixes]);
        known.knownSuffixes = { suffixes: [...suffixes].sort(), source: snapshot.source };
        continue;
      }
      directory.push(directoryManifest(snapshot, entry));
    }
  }
  directory.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return [...registrars, ...directory];
}
