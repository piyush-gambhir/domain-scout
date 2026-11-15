import type {
  Capability,
  CapabilityName,
  CredentialField,
  ProviderCapabilities,
  PurchasePath,
} from '@domain-scout/contracts';


export const DOCS_VERIFIED_AT = '2026-10-05T00:00:00.000Z';


export const DOMAIN_HUNTER_REGISTRARS =
  'https://github.com/WhiteBite/Domain-Hunter/blob/7ef726280b5c8157b97d7637548909388a5008af/src/config/registrars.json';

export interface LinkTemplate {

  template: string;
  kind: 'search' | 'dashboard' | 'website';
  source: string;
  verifiedAt: string | null;
}






export interface ProviderManifest {
  id: string;
  name: string;
  kind: 'registrar' | 'directory';
  website: string;
  setupUrl: string | null;

  apiHost: string | null;

  catalogHost?: string;
  docsUrl: string;
  credentialFields: CredentialField[];
  accountRequirements: string[];
  rateLimits: string | null;

  purchaseLink: LinkTemplate | null;

  links?: Partial<Record<Exclude<PurchasePath, 'new_registration'>, LinkTemplate>>;
  capabilities: ProviderCapabilities;

  knownSuffixes?: { suffixes: string[]; source: string };

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


export function fillTemplate(template: string, domain: string): string {
  return template.replace(/\{domain\}/g, encodeURIComponent(domain));
}
