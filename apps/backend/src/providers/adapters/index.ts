import { CloudflareAdapter } from './cloudflare.js';
import { DynadotAdapter } from './dynadot.js';
import { GoDaddyAdapter } from './godaddy.js';
import { HostingerAdapter } from './hostinger.js';
import { NamecheapAdapter } from './namecheap.js';
import { NameComAdapter } from './namecom.js';
import { NameSiloAdapter } from './namesilo.js';
import { PorkbunAdapter } from './porkbun.js';
import { SpaceshipAdapter } from './spaceship.js';
import type { ProviderAdapter } from './types.js';

/** One adapter per named provider. Directory entries have no adapter. */
export function createAdapters(): Map<string, ProviderAdapter> {
  const adapters: ProviderAdapter[] = [
    new HostingerAdapter(),
    new DynadotAdapter(),
    new PorkbunAdapter(),
    new NamecheapAdapter(),
    new GoDaddyAdapter(),
    new CloudflareAdapter(),
    new SpaceshipAdapter(),
    new NameSiloAdapter(),
    new NameComAdapter(),
  ];
  return new Map(adapters.map((a) => [a.providerId, a]));
}

export type { ProviderAdapter } from './types.js';
