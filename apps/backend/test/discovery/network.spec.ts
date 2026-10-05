import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationRequest } from '@domain-scout/contracts';
import { GenerationService } from '../../src/discovery/generation.service.js';
import { ThemeLibrary } from '../../src/discovery/themes.js';

// Scenario 11 and N04: generation sends nothing to any registry, provider, resolver or AI service.
describe('generation makes no network requests', () => {
  afterEach(() => vi.restoreAllMocks());

  it('touches no fetch, DNS, socket, TLS or HTTP API while generating every strategy', () => {
    const spies = [
      vi.spyOn(globalThis, 'fetch'),
      vi.spyOn(dns, 'lookup'),
      vi.spyOn(dns, 'resolve'),
      vi.spyOn(dns, 'resolve4'),
      vi.spyOn(dns.promises, 'lookup'),
      vi.spyOn(dns.promises, 'resolve'),
      vi.spyOn(net, 'connect'),
      vi.spyOn(net, 'createConnection'),
      vi.spyOn(net.Socket.prototype, 'connect'),
      vi.spyOn(tls, 'connect'),
      vi.spyOn(http, 'request'),
      vi.spyOn(http, 'get'),
      vi.spyOn(https, 'request'),
      vi.spyOn(https, 'get'),
    ];
    const service = new GenerationService(new ThemeLibrary());
    const result = service.preview(
      GenerationRequest.parse({
        roots: ['cloud', 'bitly'],
        themes: ['tech', 'nature', 'finance', 'abstract', 'short'],
        prefixes: ['get'],
        suffixes: ['hq'],
        strategies: ['roots', 'affixes', 'compounds', 'syllables', 'mutations', 'hacks'],
        extensions: ['com', 'ly', 'io', 'co.uk'],
        seed: 3,
        limit: 2000,
      }),
    );
    expect(new Set(result.candidates.map((c) => c.strategy)).size).toBe(6);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('discovery source imports no network module', () => {
    const dir = fileURLToPath(new URL('../../src/discovery/', import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      expect(source, file).not.toMatch(/from 'node:(dns|net|tls|http|https|dgram)'/);
      expect(source, file).not.toMatch(/\bfetch\(|undici|XMLHttpRequest|WebSocket/);
    }
  });
});
