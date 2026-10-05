import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ProviderListResponse } from '@domain-scout/contracts';
import { ProviderDirectory } from '../../src/core/ports.js';
import { CatalogHandler } from '../../src/providers/handlers.js';
import type { DirectorySnapshot } from '../../src/providers/directory.js';
import { createProvidersApp, fixture, jobItem, operationContext, type ProvidersTestApp } from './helpers.js';

const snapshot = JSON.parse(readFileSync(new URL('../../data/providers/register-si.json', import.meta.url), 'utf8')) as DirectorySnapshot;

describe('register.si snapshot', () => {
  it('is dated, sourced and lists registrars with websites', () => {
    expect(snapshot.source).toBe('https://www.register.si/en/registrars/');
    expect(snapshot.fetchedAt).toMatch(/^2026-10-05T/);
    expect(snapshot.suffixes).toEqual(['si']);
    expect(snapshot.registrars.length).toBeGreaterThan(50);
    for (const r of snapshot.registrars) {
      expect(r.id).toMatch(/^register-si-[a-z0-9-]+$/);
      expect(r.website).toMatch(/^https?:\/\//);
    }
    expect(new Set(snapshot.registrars.map((r) => r.id)).size).toBe(snapshot.registrars.length);
  });
});

describe('provider directory', () => {
  let t: ProvidersTestApp;
  beforeAll(async () => {
    t = await createProvidersApp({});
  });
  afterAll(() => t.close());
  afterEach(() => t.transport.reset());

  it('lists the nine named providers first, then registry directory entries, with pagination', async () => {
    const first = ProviderListResponse.parse((await t.api.get('/providers?limit=9').expect(200)).body);
    expect(first.data.map((p) => p.id)).toEqual(['hostinger', 'dynadot', 'porkbun', 'namecheap', 'godaddy', 'cloudflare', 'spaceship', 'namesilo', 'namecom']);
    expect(first.total).toBe(9 + snapshot.registrars.filter((r) => !r.providerId).length);
    expect(first.nextCursor).not.toBeNull();
    const second = ProviderListResponse.parse((await t.api.get(`/providers?limit=5&cursor=${first.nextCursor}`).expect(200)).body);
    expect(second.data.every((p) => p.kind === 'directory')).toBe(true);
    await t.api.get('/providers/nope').expect(404);
  });

  it('marks named providers listed by register.si as supporting .si from the registry source', async () => {
    const providers = ProviderListResponse.parse((await t.api.get('/providers?limit=9').expect(200)).body).data;
    for (const id of ['namecom', 'spaceship', 'namecheap', 'dynadot']) expect(providers.find((p) => p.id === id)?.suffixes).toContain('si');
    expect(providers.find((p) => p.id === 'hostinger')?.suffixes).toBeNull();
    expect(providers.find((p) => p.id === 'porkbun')?.apiHosts).toEqual(['api.porkbun.com']);
    expect(providers.find((p) => p.id === 'cloudflare')?.apiHosts).toEqual(['api.cloudflare.com']);
  });

  it('forDomain: unknown before a catalog, yes/no after, purchase URL from the same provider', async () => {
    const directory = t.app.get(ProviderDirectory);
    const before = directory.forDomain('xq7mz9brandtest.co.uk', 'co.uk');
    expect(before.find((p) => p.providerId === 'porkbun')).toMatchObject({ supportsSuffix: 'unknown', purchaseKind: 'search' });
    expect(before.some((p) => p.providerId.startsWith('register-si-'))).toBe(false);

    t.transport.on(/pricing\/get/, fixture('porkbun', 'pricing'));
    await t.app.get(CatalogHandler).execute(jobItem('catalog', 'porkbun', 'porkbun'), operationContext(t));
    const uk = directory.forDomain('xq7mz9brandtest.co.uk', 'co.uk').find((p) => p.providerId === 'porkbun')!;
    expect(uk).toMatchObject({ supportsSuffix: 'yes', purchaseUrl: 'https://porkbun.com/checkout/search?q=xq7mz9brandtest.co.uk' });
    // R03: .co.uk support says nothing about .uk.
    const plainUk = directory.forDomain('xq7mz9brandtest.uk', 'uk').find((p) => p.providerId === 'porkbun')!;
    expect(plainUk).toMatchObject({ supportsSuffix: 'no', purchaseUrl: null });
  });

  it('forDomain for .si includes registry-published registrars with their websites', () => {
    const si = t.app.get(ProviderDirectory).forDomain('xq7mz9brandtest.si', 'si');
    const arnes = si.find((p) => p.providerId === 'register-si-arnes-si')!;
    const website = snapshot.registrars.find((r) => r.id === 'register-si-arnes-si')!.website;
    expect(arnes).toMatchObject({ supportsSuffix: 'yes', purchaseUrl: website, purchaseKind: 'search' });
    expect(si.find((p) => p.providerId === 'namecom')?.supportsSuffix).toBe('yes');
  });

  it('every purchase URL belongs to the provider it is listed under (TRIAL.md link mismatch)', () => {
    const directory = t.app.get(ProviderDirectory);
    const hosts: Record<string, string> = {
      hostinger: 'www.hostinger.com',
      dynadot: 'www.dynadot.com',
      porkbun: 'porkbun.com',
      namecheap: 'namecheap.com',
      godaddy: 'www.godaddy.com',
      cloudflare: 'domains.cloudflare.com',
      spaceship: 'spaceship.com',
      namesilo: 'www.namesilo.com',
      namecom: 'www.name.com',
    };
    for (const entry of directory.forDomain('xq7mz9brandtest.com', 'com')) {
      if (!entry.purchaseUrl) continue;
      expect(new URL(entry.purchaseUrl).hostname, entry.providerId).toBe(hosts[entry.providerId]);
    }
  });

  it('summary reports readiness for the named providers', () => {
    const summary = t.app.get(ProviderDirectory).summary();
    expect(summary).toHaveLength(9);
    expect(summary.find((s) => s.id === 'porkbun')?.readiness).toBe('credentials_missing');
    expect(t.app.get(ProviderDirectory).exists('register-si-arnes-si')).toBe(true);
    expect(t.app.get(ProviderDirectory).exists('nope')).toBe(false);
  });
});
