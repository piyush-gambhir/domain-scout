import type {
  Capability,
  CapabilityName,
  CredentialField,
  ProviderCapabilities,
  PurchasePath,
} from '@domain-scout/contracts';

/** Date the official documentation behind these manifests was read. */
export const DOCS_VERIFIED_AT = '2026-10-05T00:00:00.000Z';

/** Pinned Domain Hunter registrar list (MIT): provenance for storefront search templates we did not open. */
export const DOMAIN_HUNTER_REGISTRARS =
  'https://github.com/WhiteBite/Domain-Hunter/blob/7ef726280b5c8157b97d7637548909388a5008af/src/config/registrars.json';

export interface LinkTemplate {
  /** URL template; `{domain}` is replaced with the percent-encoded ASCII domain. */
  template: string;
  kind: 'search' | 'dashboard';
  source: string;
  verifiedAt: string | null;
}

/**
 * Static description of one provider. Capability levels are deliberately conservative:
 * authenticated capabilities are at most fixture_tested (no live keys exist), and anything the
 * official documentation leaves unconfirmed stays documented.
 */
export interface ProviderManifest {
  id: string;
  name: string;
  kind: 'registrar' | 'directory';
  website: string;
  setupUrl: string | null;
  /** Host candidate names are disclosed to by authenticated operations. */
  apiHost: string | null;
  /** Host the catalog is fetched from, when different from apiHost. */
  catalogHost?: string;
  docsUrl: string;
  credentialFields: CredentialField[];
  accountRequirements: string[];
  rateLimits: string | null;
  /** New-registration handoff. */
  purchaseLink: LinkTemplate | null;
  /** Other purchase paths, when the provider has a distinct destination for them. */
  links?: Partial<Record<Exclude<PurchasePath, 'new_registration'>, LinkTemplate>>;
  capabilities: ProviderCapabilities;
  /** Suffixes the provider is known to support from a published source, independent of catalogs. */
  knownSuffixes?: { suffixes: string[]; source: string };
  /** Default currency of prices that carry no currency field. */
  currency?: string;
}

export function cap(
  level: Capability['level'],
  requiresCredentials: boolean,
  source: string | null,
  notes: string | null,
  verifiedAt: string | null = level === 'unsupported' ? null : DOCS_VERIFIED_AT,
): Capability {
  return { level, requiresCredentials, source, verifiedAt, notes };
}

export function unsupported(notes: string): Capability {
  return cap('unsupported', false, null, notes, null);
}

export function field(
  providerId: string,
  key: string,
  label: string,
  options: { secret?: boolean; required?: boolean; help?: string | null } = {},
): CredentialField {
  return {
    key,
    label,
    secret: options.secret ?? true,
    required: options.required ?? true,
    help: options.help ?? null,
    envVar: credentialEnvVar(providerId, key),
  };
}

/** DOMAIN_SCOUT_<PROVIDER>_<FIELD>, e.g. DOMAIN_SCOUT_PORKBUN_SECRET_API_KEY. */
export function credentialEnvVar(providerId: string, key: string): string {
  const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return `DOMAIN_SCOUT_${providerId.replace(/-/g, '_')}_${snake}`.toUpperCase();
}

export function hasAuthenticatedCapability(manifest: ProviderManifest): boolean {
  return Object.values(manifest.capabilities).some((c) => c.level !== 'unsupported' && c.requiresCredentials);
}

export function capability(manifest: ProviderManifest, name: CapabilityName): Capability {
  return manifest.capabilities[name];
}

/** Builds the destination URL for a domain from the provider's own template. */
export function fillTemplate(template: string, domain: string): string {
  return template.replace(/\{domain\}/g, encodeURIComponent(domain));
}
