import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Offer, ProviderConfirmation } from '@domain-scout/contracts';
import { Database } from '../../src/storage/database.js';
import { EvidenceRepository } from '../../src/storage/evidence.js';
import { TransportError } from '../../src/providers/transport.js';
import {
  AftermarketHandler,
  CatalogHandler,
  ProviderCheckHandler,
  QuoteHandler,
  TransferHandler,
} from '../../src/providers/handlers.js';
import { OperationRegistry } from '../../src/jobs/operation-registry.js';
import { createProvidersApp, fixture, jobItem, operationContext, serialized, type ProvidersTestApp } from './helpers.js';

const NAMECHEAP_ENV = {
  DOMAIN_SCOUT_NAMECHEAP_API_USER: 'handleruser',
  DOMAIN_SCOUT_NAMECHEAP_API_KEY: 'nc_handler_secret_key_0001',
  DOMAIN_SCOUT_NAMECHEAP_CLIENT_IP: '198.51.100.7',
};
const CLOUDFLARE_ENV = { DOMAIN_SCOUT_CLOUDFLARE_ACCOUNT_ID: 'acc0123', DOMAIN_SCOUT_CLOUDFLARE_API_TOKEN: 'cf_handler_token_0001' };
const PORKBUN_ENV = { DOMAIN_SCOUT_PORKBUN_API_KEY: 'pk1_handlerkey_0001', DOMAIN_SCOUT_PORKBUN_SECRET_API_KEY: 'sk1_handlersecret_0001' };
const HOSTINGER_ENV = { DOMAIN_SCOUT_HOSTINGER_API_TOKEN: 'hostinger_handler_token_0001' };
const DOMAIN = 'xq7mz9brandtest.com';

describe('provider handlers', () => {
  let t: ProvidersTestApp;
  beforeAll(async () => {
    t = await createProvidersApp({ ...PORKBUN_ENV, ...HOSTINGER_ENV, ...NAMECHEAP_ENV, ...CLOUDFLARE_ENV });
  });
  afterAll(() => t.close());
  afterEach(() => t.transport.reset());

  it('registers provider_check, quote, transfer, aftermarket and catalog handlers', () => {
    const registry = t.app.get(OperationRegistry);
    for (const op of ['provider_check', 'quote', 'transfer', 'aftermarket', 'catalog'] as const) expect(registry.get(op)).toBeDefined();
  });

  it('uses provider:<id> source keys and the API host as destination', () => {
    const quote = t.app.get(QuoteHandler);
    const item = jobItem('quote', DOMAIN, 'porkbun', 'com');
    expect(quote.sourceKey(item)).toBe('provider:porkbun');
    expect(quote.destination(item)).toBe('api.porkbun.com');
    const catalog = t.app.get(CatalogHandler);
    expect(catalog.sourceKey(jobItem('catalog', 'porkbun', 'porkbun'))).toBe('provider:porkbun');
  });

  it('quotes: records a confirmation and an exact offer whose link is the same provider', async () => {
    t.transport.on(/checkDomain/, fixture('porkbun', 'check-available', { domain: DOMAIN }));
    const result = await t.app.get(QuoteHandler).execute(jobItem('quote', DOMAIN, 'porkbun', 'com'), operationContext(t));
    expect(result).toMatchObject({ outcome: 'quoted', resolved: true, error: null });
    const confirmation = result.evidence.find((e) => e.kind === 'observation')!;
    expect(confirmation.row).toMatchObject({ kind: 'confirmation', subject: DOMAIN, outcome: 'available', destination: 'api.porkbun.com' });
    expect((confirmation.row as unknown as { payload: ProviderConfirmation }).payload).toMatchObject({ providerId: 'porkbun', status: 'available' });
    const offer = result.evidence.find((e) => e.kind === 'offer')!.row as unknown as { payload: Offer; staleAt: string; domain: string };
    expect(offer.domain).toBe(DOMAIN);
    expect(offer.payload.destination).toEqual({ url: `https://porkbun.com/checkout/search?q=${DOMAIN}`, kind: 'search' });
    expect(offer.staleAt).toBe('2026-10-05T12:15:00.000Z');
    expect(serialized(result)).not.toContain(PORKBUN_ENV.DOMAIN_SCOUT_PORKBUN_SECRET_API_KEY);
  });

  it('missing credentials finish as credential_required without any request', async () => {
    const result = await t.app.get(QuoteHandler).execute(jobItem('quote', DOMAIN, 'namesilo', 'com'), operationContext(t));
    expect(result).toMatchObject({ outcome: 'credential_required', resolved: false, retryable: false });
    expect(result.error?.message).toContain('DOMAIN_SCOUT_NAMESILO_API_KEY');
    expect(t.transport.requests).toHaveLength(0);
  });

  it('unsupported capabilities finish as unsupported without any request', async () => {
    const transfer = await t.app.get(TransferHandler).execute(jobItem('transfer', DOMAIN, 'godaddy', 'com'), operationContext(t));
    expect(transfer).toMatchObject({ outcome: 'unsupported', resolved: false });
    const directory = await t.app.get(ProviderCheckHandler).execute(jobItem('provider_check', 'x.si', 'register-si-arnes-si', 'si'), operationContext(t));
    expect(directory.outcome).toBe('unsupported');
    const marketplace = await t.app.get(AftermarketHandler).execute(jobItem('aftermarket', DOMAIN, 'sedo', 'com'), operationContext(t));
    expect(marketplace.outcome).toBe('unsupported');
    expect(t.transport.requests).toHaveLength(0);
  });

  it('rate limits become a shared cooldown with retryAt', async () => {
    t.transport.on(/checkDomain/, fixture('porkbun', 'rate-limited'));
    const result = await t.app.get(ProviderCheckHandler).execute(jobItem('provider_check', DOMAIN, 'porkbun', 'com'), operationContext(t));
    expect(result).toMatchObject({ outcome: 'rate_limited', resolved: false, retryable: true, cooldownUntil: '2026-10-05T12:00:07.000Z' });
  });

  it('network failures are retryable errors and record no evidence', async () => {
    t.transport.on(/checkDomain/, new TransportError('timeout', 'Request timed out'));
    const result = await t.app.get(ProviderCheckHandler).execute(jobItem('provider_check', DOMAIN, 'porkbun', 'com'), operationContext(t));
    expect(result).toMatchObject({ outcome: 'error', retryable: true, evidence: [] });
    expect(result.error?.code).toBe('provider_unavailable');
  });

  it('Hostinger quotes record availability and a published (suffix-level) price only', async () => {
    t.transport.on(/availability$/, fixture('hostinger', 'availability', { domain: DOMAIN })).on(/billing\/v1\/catalog/, fixture('hostinger', 'catalog'));
    const result = await t.app.get(QuoteHandler).execute(jobItem('quote', DOMAIN, 'hostinger', 'com'), operationContext(t));
    const offer = result.evidence.find((e) => e.kind === 'offer')!.row as unknown as { domain: string | null; kind: string; payload: Offer };
    expect(offer.domain).toBeNull();
    expect(offer.kind).toBe('published');
    expect(offer.payload.premium.status).toBe('unknown');
    expect(result.evidence.some((e) => e.kind === 'observation' && e.row.kind === 'confirmation')).toBe(true);
  });

  it('one provider failing leaves other providers and registry evidence untouched (scenario 7)', async () => {
    const evidence = t.app.get(EvidenceRepository);
    const db = t.app.get(Database);
    evidence.insertObservation({
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'registry',
      subject: DOMAIN,
      suffix: 'com',
      sourceId: 'verisign',
      destination: 'https://rdap.verisign.com/com/v1/',
      outcome: 'no_record',
      observedAt: '2026-10-05T11:59:00.000Z',
      staleAt: '2026-10-05T12:14:00.000Z',
      payload: { id: '00000000-0000-4000-8000-000000000001', domain: DOMAIN, outcome: 'no_record' },
    });
    t.transport.on(/hostinger/, fixture('hostinger', 'unauthorized')).on(/checkDomain/, fixture('porkbun', 'check-available', { domain: DOMAIN }));
    const failed = await t.app.get(QuoteHandler).execute(jobItem('quote', DOMAIN, 'hostinger', 'com'), operationContext(t));
    const ok = await t.app.get(QuoteHandler).execute(jobItem('quote', DOMAIN, 'porkbun', 'com'), operationContext(t));
    expect(failed).toMatchObject({ outcome: 'credentials_invalid', resolved: false, retryable: false, evidence: [] });
    expect(failed.error?.message).toContain('hpanel.hostinger.com');
    expect(ok.outcome).toBe('quoted');
    expect(db.get<{ outcome: string }>('SELECT outcome FROM observations WHERE kind = ? AND subject = ?', ['registry', DOMAIN])?.outcome).toBe('no_record');
    // The auth failure marks only Hostinger's credentials invalid.
    const providers = (await t.api.get('/providers?limit=20').expect(200)).body.data as { id: string; readiness: string }[];
    expect(providers.find((p) => p.id === 'hostinger')?.readiness).toBe('credentials_invalid');
    expect(providers.find((p) => p.id === 'porkbun')?.readiness).toBe('ready');
  });

  it('aftermarket lookups record listing evidence with the caveat', async () => {
    t.transport.on(/marketplace\/getAll/, fixture('porkbun', 'marketplace'));
    const result = await t.app.get(AftermarketHandler).execute(jobItem('aftermarket', 'example-listing.com', 'porkbun', 'com'), operationContext(t));
    expect(result).toMatchObject({ outcome: 'listed', resolved: true });
    const row = result.evidence[0]!.row as unknown as { kind: string; payload: { caveat: string; price: unknown; providerId: string } };
    expect(row.kind).toBe('listing');
    expect(row.payload).toMatchObject({ providerId: 'porkbun', price: { amount: '1250.00', currency: 'USD' } });
    expect(row.payload.caveat).toContain('not proof of seller authority');
  });

  it('scrubs secrets that a provider echoes back in its own text', async () => {
    const key = NAMECHEAP_ENV.DOMAIN_SCOUT_NAMECHEAP_API_KEY;
    const body = fixture('namecheap', 'check-available', { domain: DOMAIN }).body.replace('ErrorNo="0" Description=""', `ErrorNo="2" Description="Bad ApiKey ${key}"`);
    t.transport.on(/domains.check/, { status: 200, headers: {}, body });
    const result = await t.app.get(ProviderCheckHandler).execute(jobItem('provider_check', DOMAIN, 'namecheap', 'com'), operationContext(t));
    expect(result.outcome).toBe('unknown');
    expect(serialized(result)).toContain('[redacted]');
    expect(serialized(result)).not.toContain(key);
    // Codes are scrubbed too (a provider could echo a token as a reason code).
    const cfToken = CLOUDFLARE_ENV.DOMAIN_SCOUT_CLOUDFLARE_API_TOKEN;
    const cf = JSON.stringify({ success: true, errors: [], messages: [], result: { domains: [{ name: DOMAIN, registrable: false, reason: `odd_${cfToken}` }] } });
    t.transport.on(/domain-check/, { status: 200, headers: {}, body: cf });
    const echoed = await t.app.get(ProviderCheckHandler).execute(jobItem('provider_check', DOMAIN, 'cloudflare', 'com'), operationContext(t));
    expect(serialized(echoed)).not.toContain(cfToken);
  });

  it('an offer without the amount for its path is not a quote', async () => {
    const body = JSON.stringify({ success: true, errors: [], messages: [], result: { domains: [{ name: DOMAIN, registrable: true, tier: 'standard', pricing: { currency: 'USD' } }] } });
    t.transport.on(/domain-check/, { status: 200, headers: {}, body });
    const result = await t.app.get(QuoteHandler).execute(jobItem('quote', DOMAIN, 'cloudflare', 'com'), operationContext(t));
    expect(result).toMatchObject({ outcome: 'no_price', resolved: false });
    expect(result.evidence.every((e) => e.kind === 'observation')).toBe(true);
  });

  it('transfer quotes record a transfer-path offer with the transfer line', async () => {
    t.transport.on(/checkDomain/, fixture('porkbun', 'check-unavailable'));
    const result = await t.app.get(TransferHandler).execute(jobItem('transfer', 'example.com', 'porkbun', 'com'), operationContext(t));
    expect(result).toMatchObject({ outcome: 'quoted', resolved: true });
    const offer = result.evidence[0]!.row as { purchasePath: string; transfer: string };
    expect(offer).toMatchObject({ purchasePath: 'transfer', transfer: '11.08' });
  });
});
