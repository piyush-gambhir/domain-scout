import type { NameCheckService, NameCheckServiceId } from '@domain-scout/contracts';

/** Manifest of name-check services. Only documented, keyless, dependable interfaces are supported. */
export interface SupportedService {
  id: NameCheckServiceId;
  name: string;
  namespace: string;
  supported: true;
  host: string;
  url(name: string): string;
  accept: string;
  /** Returns a reason when the name breaks the service's naming rules (then no request is sent). */
  validate(name: string): string | null;
  /** Small structured detail from the body; `json` is null when the bounded body did not parse. */
  detail(json: Record<string, unknown> | null, text: string): Record<string, unknown>;
  /** Name the service returned, for identity checks; null when the body does not state one. */
  returnedName(json: Record<string, unknown> | null): string | null;
  /** Identity field read from a truncated body's prefix, so truncation never skips verification. */
  textName(text: string): string | null;
  /**
   * Canonical name when a redirect only canonicalizes the requested name on the same host (PyPI
   * redirects to the project's display name). The handler follows one such redirect and verifies
   * the target body; null means the redirect is unexpected and is not followed.
   */
  canonicalRedirect?(location: URL, name: string): string | null;
  /** Service-specific name equivalence (case, separators). */
  same(a: string, b: string): boolean;
}

export interface UnsupportedService {
  id: NameCheckServiceId;
  name: string;
  namespace: string;
  supported: false;
  reason: string;
}

export type ServiceSpec = SupportedService | UnsupportedService;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const match = (text: string, pattern: RegExp): string | null => pattern.exec(text)?.[1] ?? null;

const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYPI_NAME = /^([A-Z0-9]|[A-Z0-9][A-Z0-9._-]*[A-Z0-9])$/i;
const CRATE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const pep503 = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

const NO_PUBLIC_API = 'publishes no documented public interface for checking whether an arbitrary handle exists without an account or app review';

export const SERVICES: Record<NameCheckServiceId, ServiceSpec> = {
  github: {
    id: 'github',
    name: 'GitHub',
    namespace: 'GitHub user or organization login',
    supported: true,
    host: 'api.github.com',
    url: (name) => `https://api.github.com/users/${encodeURIComponent(name)}`,
    accept: 'application/vnd.github+json',
    validate: (name) =>
      GITHUB_LOGIN.test(name)
        ? null
        : 'GitHub logins are 1 to 39 letters, digits or single hyphens, and cannot start or end with a hyphen',
    detail: (json) => ({ type: str(json?.type), login: str(json?.login) }),
    returnedName: (json) => str(json?.login),
    textName: (text) => match(text, /"login"\s*:\s*"([^"]+)"/),
    same: (a, b) => a.toLowerCase() === b.toLowerCase(),
  },
  npm: {
    id: 'npm',
    name: 'npm',
    namespace: 'npm package name',
    supported: true,
    host: 'registry.npmjs.org',
    // The latest-version manifest is small and always states "name", so identity is verifiable.
    // Scoped names encode the slash (@scope%2Fname).
    url: (name) =>
      `https://registry.npmjs.org/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}/latest`,
    accept: 'application/json',
    validate: (name) =>
      name.length > 214
        ? 'npm package names are at most 214 characters'
        : NPM_NAME.test(name)
          ? null
          : 'npm package names are lower case and URL safe, may be scoped (@scope/name) and cannot start with a dot or underscore',
    detail: (json, text) => ({ latestVersion: str(json?.version) ?? match(text, /"version"\s*:\s*"([^"]+)"/) }),
    returnedName: (json) => str(json?.name),
    textName: (text) => match(text, /^\s*\{\s*"name"\s*:\s*"([^"]+)"/),
    same: (a, b) => a === b,
  },
  pypi: {
    id: 'pypi',
    name: 'PyPI',
    namespace: 'PyPI project name',
    supported: true,
    host: 'pypi.org',
    url: (name) => `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
    accept: 'application/json',
    validate: (name) =>
      PYPI_NAME.test(name)
        ? null
        : 'PyPI project names use letters, digits, dots, hyphens and underscores, and start and end with a letter or digit',
    detail: (json, text) => ({
      projectName: str(obj(json?.info)?.name) ?? match(text, /"info"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"/),
      latestVersion: str(obj(json?.info)?.version) ?? match(text, /"info"\s*:\s*\{[\s\S]*?"version"\s*:\s*"([^"]+)"/),
    }),
    returnedName: (json) => str(obj(json?.info)?.name),
    textName: (text) => match(text, /"info"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"/),
    same: (a, b) => pep503(a) === pep503(b),
    canonicalRedirect: (location, name) => {
      const canonical = /^\/pypi\/([^/]+)\/json\/?$/.exec(location.pathname)?.[1];
      if (location.protocol !== 'https:' || location.host !== 'pypi.org' || location.search || !canonical) return null;
      let decoded: string;
      try {
        decoded = decodeURIComponent(canonical);
      } catch {
        return null; // A malformed escape is not a canonical-name redirect.
      }
      return pep503(decoded) === pep503(name) ? decoded : null;
    },
  },
  crates: {
    id: 'crates',
    name: 'crates.io',
    namespace: 'crates.io crate name',
    supported: true,
    host: 'crates.io',
    url: (name) => `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
    accept: 'application/json',
    validate: (name) =>
      CRATE_NAME.test(name)
        ? null
        : 'Crate names start with a letter and use at most 64 ASCII letters, digits, hyphens or underscores',
    detail: (json, text) => ({
      crateName: str(obj(json?.crate)?.name) ?? match(text, /"crate"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"/),
      maxVersion: str(obj(json?.crate)?.max_version) ?? match(text, /"max_version"\s*:\s*"([^"]+)"/),
    }),
    returnedName: (json) => str(obj(json?.crate)?.name),
    textName: (text) => match(text, /"crate"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"/),
    same: (a, b) => a.toLowerCase().replace(/_/g, '-') === b.toLowerCase().replace(/_/g, '-'),
  },
  x: { id: 'x', name: 'X', namespace: 'X (Twitter) handle', supported: false, reason: `X ${NO_PUBLIC_API}; profile pages are not scraped` },
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    namespace: 'Instagram username',
    supported: false,
    reason: `Instagram ${NO_PUBLIC_API}; profile pages are not scraped`,
  },
  tiktok: { id: 'tiktok', name: 'TikTok', namespace: 'TikTok username', supported: false, reason: `TikTok ${NO_PUBLIC_API}; profile pages are not scraped` },
  linkedin: {
    id: 'linkedin',
    name: 'LinkedIn',
    namespace: 'LinkedIn profile or company URL name',
    supported: false,
    reason: `LinkedIn ${NO_PUBLIC_API}; profile pages are not scraped`,
  },
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    namespace: 'YouTube channel handle',
    supported: false,
    reason: 'The YouTube Data API requires a Google API key and quota; keyless handle lookups are not offered, and pages are not scraped',
  },
  reddit: {
    id: 'reddit',
    name: 'Reddit',
    namespace: 'Reddit username',
    supported: false,
    reason: 'The Reddit API requires registered OAuth access under its developer terms; keyless lookups are not offered, and pages are not scraped',
  },
};

export function serviceManifest(): NameCheckService[] {
  return Object.values(SERVICES).map((s) => ({
    id: s.id,
    name: s.name,
    namespace: s.namespace,
    supported: s.supported,
    destination: s.supported ? s.host : null,
    reason: s.supported ? null : s.reason,
  }));
}
