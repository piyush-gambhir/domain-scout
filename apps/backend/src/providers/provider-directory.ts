import { Injectable } from '@nestjs/common';
import type { ProviderReadiness } from '@domain-scout/contracts';
import { ProviderDirectory, type SuffixProvider } from '../core/ports.js';
import { ProvidersService } from './providers.service.js';


@Injectable()
export class ProviderDirectoryService extends ProviderDirectory {
  constructor(private readonly providers: ProvidersService) {
    super();
  }


  summary(): { id: string; name: string; readiness: ProviderReadiness }[] {
    return this.providers
      .manifests()
      .filter((m) => m.kind === 'registrar')
      .map((m) => ({ id: m.id, name: m.name, readiness: this.providers.readiness(m) }));
  }






  forDomain(domain: string, suffix: string): SuffixProvider[] {
    const out: SuffixProvider[] = [];
    for (const manifest of this.providers.manifests()) {
      const supportsSuffix = this.providers.supportsSuffix(manifest, suffix);
      if (manifest.kind === 'directory' && supportsSuffix !== 'yes') continue;
      const row = this.providers.row(manifest.id);
      const link = supportsSuffix === 'no' ? null : this.providers.destination(manifest.id, domain, 'new_registration');
      out.push({
        providerId: manifest.id,
        name: manifest.name,
        kind: manifest.kind,
        supportsSuffix,
        purchaseUrl: link?.url ?? null,
        purchaseKind: link?.kind ?? null,
        enabled: row.enabled === 1,
        preferred: row.preferred === 1,
      });
    }
    return out;
  }

  exists(providerId: string): boolean {
    return this.providers.manifest(providerId) !== undefined;
  }
}
