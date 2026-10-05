import type { GeneratedCandidate, GenerationStrategy } from '@domain-scout/contracts';
import { uniq } from '@/lib/utils';

/** A candidate in the editable list: generated locally by the backend, or typed in by the user. */
export interface Candidate {
  /** Stable identity: the complete domain for hacks, else the label. */
  key: string;
  name: string;
  domain: string | null;
  strategy: GenerationStrategy | 'added';
  rule: string;
  valid: boolean;
  issues: string[];
}

export function fromGenerated(candidate: GeneratedCandidate): Candidate {
  return { ...candidate, key: candidate.domain ?? candidate.name };
}

const LABEL = /^[a-z0-9-]+$/;

/** LDH checks for a label typed by the user, mirroring the generator's rules. */
function labelIssues(label: string): string[] {
  const issues: string[] = [];
  if (!label) return ['empty label'];
  if (label.length > 63) issues.push('label longer than 63 characters');
  if (!LABEL.test(label)) issues.push('invalid characters: only a-z, 0-9 and hyphen are allowed');
  if (label.startsWith('-') || label.endsWith('-')) issues.push('hyphen at the start or end of the label');
  if (label.slice(2, 4) === '--') issues.push('hyphens in the third and fourth positions are reserved');
  return issues;
}

/** A user-supplied name or complete domain. Complete domains keep their own extension. */
export function addedCandidate(raw: string): Candidate {
  const value = raw.trim().toLowerCase().replace(/\.+$/, '');
  const isDomain = value.includes('.');
  const issues = isDomain ? value.split('.').flatMap(labelIssues) : labelIssues(value);
  if (isDomain && value.length > 253) issues.push('domain longer than 253 characters');
  return {
    key: value,
    name: value,
    domain: isDomain ? value : null,
    strategy: 'added',
    rule: isDomain ? 'added by you as a complete domain' : 'added by you',
    valid: issues.length === 0,
    issues: uniq(issues),
  };
}

/** Splits free entry on whitespace, commas and semicolons; lower case, unique, in order. */
export function parseList(text: string): string[] {
  return uniq(
    text
      .split(/[\s,;]+/)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Distinct domains a scan of these candidates would check: each label under each extension (at most
 * 253 characters) plus each complete domain. Same rule as the backend's expandedChecks.
 */
export function expandedDomains(candidates: Candidate[], extensions: string[]): number {
  const domains = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.valid) continue;
    if (candidate.domain) {
      domains.add(candidate.domain);
      continue;
    }
    for (const ext of extensions) {
      const domain = `${candidate.name}.${ext}`;
      if (domain.length <= 253) domains.add(domain);
    }
  }
  return domains.size;
}

export const STRATEGY_LABEL: Record<Candidate['strategy'], string> = {
  roots: 'Root',
  affixes: 'Affix',
  compounds: 'Compound',
  syllables: 'Syllables',
  mutations: 'Variation',
  hacks: 'Domain hack',
  added: 'Added',
};
