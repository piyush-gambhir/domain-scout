import { describe, expect, it } from 'vitest';
import { CloudflareAdapter } from '../../src/providers/adapters/cloudflare.js';
import { DynadotAdapter } from '../../src/providers/adapters/dynadot.js';
import { GoDaddyAdapter, godaddyOffer } from '../../src/providers/adapters/godaddy.js';
import { scrubSecrets } from '../../src/providers/adapters/http.js';
import { computeRow } from '../../src/pricing/comparison.js';
import { HostingerAdapter, parseHostingerCatalog } from '../../src/providers/adapters/hostinger.js';
import { parseXml } from '../../src/providers/adapters/xml.js';
import { NamecheapAdapter } from '../../src/providers/adapters/namecheap.js';
import { NameComAdapter } from '../../src/providers/adapters/namecom.js';
import { NameSiloAdapter } from '../../src/providers/adapters/namesilo.js';
import { PorkbunAdapter } from '../../src/providers/adapters/porkbun.js';
import { SpaceshipAdapter } from '../../src/providers/adapters/spaceship.js';
import { ProviderError, type DomainParts } from '../../src/providers/adapters/types.js';
import { REGISTRAR_MANIFESTS } from '../../src/providers/manifests.js';
import { FakeTransport, adapterContext, fixture } from './helpers.js';

// Fixtures are reconstructed from official documentation (see each file's provenance); no live keys exist.
const name = (ascii: string): DomainParts => {
  const [label, ...rest] = ascii.split('.');
  return { ascii, label: label!, suffix: rest.join('.') };
};
const DOMAIN = name('xq7mz9brandtest.com');

async function rejects(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error('expected a ProviderError');
}

describe('Porkbun adapter', () => {
  const creds = { apiKey: 'pk1_fixturekey_0001', secretApiKey: 'sk1_fixturesecret_0001' };
  const adapter = new PorkbunAdapter();

  it('fetches the keyless catalog without credentials or names and parses USD prices', async () => {
    const t = new FakeTransport().on('https://api.porkbun.com/api/json/v3/pricing/get', fixture('porkbun', 'pricing'));
    const result = await adapter.catalog(adapterContext(t));
    const req = t.requests[0]!;
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.porkbun.com/api/json/v3/pricing/get');
    expect(Object.keys(req.headers ?? {}).map((h) => h.toLowerCase())).not.toContain('x-api-key');
    expect(req.body).toBeUndefined();
    expect(result.suffixes).toEqual(['com', 'co.uk', 'si']);
    const com = result.entries.find((e) => e.suffix === 'com')!;
    expect(com).toMatchObject({ kind: 'published', currency: 'USD', registration: { amount: '11.08', years: 1 }, renewal: { amount: '11.08' } });
    expect(com.transfer).toEqual({ amount: '11.08', includesYears: null });
    expect(com.promotion?.description).toContain('AWESOMENESS');
    expect(com.promotion?.eligibilityVerified).toBe(false);
    expect(com.promotional).toBe(false);
    expect(com.fees).toEqual({ icann: null, other: [], tax: 'unknown' });
  });

  it('parses the captured live response (coupons as an empty array)', async () => {
    const t = new FakeTransport().on(/pricing\/get/, fixture('porkbun', 'pricing-live'));
    const result = await adapter.catalog(adapterContext(t));
    expect(result.suffixes).toEqual(expect.arrayContaining(['com', 'si', 'co.uk', 'uk', 'de']));
    for (const entry of result.entries) {
      expect(entry.currency).toBe('USD');
      expect(entry.registration.amount ?? '0.00').toMatch(/^\d+\.\d{2,}$/);
    }
  });

  it('tests credentials with GET /ping and key headers', async () => {
    const t = new FakeTransport().on(/\/ping$/, fixture('porkbun', 'ping-ok'));
    const outcome = await adapter.testCredentials(adapterContext(t, creds));
    expect(outcome.operation).toBe('GET /ping');
    expect(t.requests[0]).toMatchObject({ method: 'GET', url: 'https://api.porkbun.com/api/json/v3/ping' });
    expect(t.requests[0]!.headers).toMatchObject({ 'X-API-Key': creds.apiKey, 'X-Secret-API-Key': creds.secretApiKey });
  });

  it('maps INVALID_API_KEYS_001 (HTTP 400) to an auth failure without echoing secrets', async () => {
    const t = new FakeTransport().on(/\/ping$/, fixture('porkbun', 'ping-invalid'));
    const error = await rejects(adapter.testCredentials(adapterContext(t, creds)));
    expect(error.kind).toBe('auth');
    expect(error.message).not.toContain(creds.secretApiKey);
  });

  it('quotes an exact name with promo, renewal and transfer prices', async () => {
    const t = new FakeTransport().on(/checkDomain/, fixture('porkbun', 'check-available', { domain: DOMAIN.ascii }));
    const quote = await adapter.quote(adapterContext(t, creds), DOMAIN);
    expect(t.requests[0]).toMatchObject({ method: 'POST', url: `https://api.porkbun.com/api/json/v3/domain/checkDomain/${DOMAIN.ascii}`, body: '{}' });
    expect(quote.check?.status).toBe('available');
    const offer = quote.offers[0]!;
    expect(offer).toMatchObject({
      kind: 'exact_quote',
      currency: 'USD',
      registration: { amount: '9.73', years: 1 },
      renewal: { amount: '11.08', years: 1 },
      transfer: { amount: '11.08', includesYears: null },
      minYears: 1,
      promotional: true,
      premium: { status: 'not_premium', registration: null, renewal: null },
    });
    expect(offer.promotion?.description).toContain('11.08');
  });

  it('records premium status and minimum duration', async () => {
    const t = new FakeTransport().on(/checkDomain/, fixture('porkbun', 'check-premium'));
    const offer = (await adapter.quote(adapterContext(t, creds), DOMAIN)).offers[0]!;
    expect(offer.premium).toEqual({ status: 'confirmed', registration: '2450.00', renewal: '61.25' });
    expect(offer.minYears).toBe(2);
  });

  it('returns no offer for an unavailable name and states unavailable', async () => {
    const t = new FakeTransport().on(/checkDomain/, fixture('porkbun', 'check-unavailable'));
    const quote = await adapter.quote(adapterContext(t, creds), DOMAIN);
    expect(quote.check?.status).toBe('unavailable');
    expect(quote.offers).toEqual([]);
  });

  it('turns 429 into rate_limited with the Retry-After time', async () => {
    const t = new FakeTransport().on(/checkDomain/, fixture('porkbun', 'rate-limited'));
    const error = await rejects(adapter.check(adapterContext(t, creds), DOMAIN));
    expect(error.kind).toBe('rate_limited');
    expect(error.extras.retryAt).toBe('2026-10-05T12:00:07.000Z');
  });

  it('reads a transfer price and marketplace listings', async () => {
    const t = new FakeTransport()
      .on(/checkDomain/, fixture('porkbun', 'check-available'))
      .on(/marketplace\/getAll/, fixture('porkbun', 'marketplace'));
    const transfer = await adapter.transfer(adapterContext(t, creds), DOMAIN);
    expect(transfer.offers[0]).toMatchObject({ purchasePath: 'transfer', transfer: { amount: '11.08', includesYears: null } });
    const listed = await adapter.aftermarket(adapterContext(t, creds), name('example-listing.com'));
    expect(listed).toMatchObject({ status: 'fixed_price', price: { amount: '1250.00', currency: 'USD' } });
    const body = JSON.parse(t.requests.at(-1)!.body!);
    expect(body).toEqual({ query: 'example-listing', tlds: ['com'], sortName: 'domain' });
    const absent = await adapter.aftermarket(adapterContext(t, creds), name('example-nolisting.com'));
    expect(absent.status).toBe('not_listed');
  });
});

describe('Namecheap adapter', () => {
  const creds = { apiUser: 'fixtureuser', apiKey: 'nc_fixture_key_0001', clientIp: '198.51.100.7' };
  const adapter = new NamecheapAdapter();

  it('sends global parameters on GET and tests with users.getBalances', async () => {
    const t = new FakeTransport().on(/Command=namecheap.users.getBalances/, fixture('namecheap', 'get-balances'));
    await adapter.testCredentials(adapterContext(t, creds));
    const url = new URL(t.requests[0]!.url);
    expect(t.requests[0]!.method).toBe('GET');
    expect(url.origin + url.pathname).toBe('https://api.namecheap.com/xml.response');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ApiUser: 'fixtureuser',
      ApiKey: creds.apiKey,
      UserName: 'fixtureuser',
      ClientIp: '198.51.100.7',
      Command: 'namecheap.users.getBalances',
    });
  });

  it('maps an API-key ERROR envelope to auth with an actionable message and no key', async () => {
    const t = new FakeTransport().on(/xml.response/, fixture('namecheap', 'error-api-key'));
    const error = await rejects(adapter.testCredentials(adapterContext(t, creds)));
    expect(error.kind).toBe('auth');
    expect(error.message).toContain('whitelisted client IP');
    expect(error.message).not.toContain(creds.apiKey);
  });

  it('parses one-year account prices from users.getPricing', async () => {
    const t = new FakeTransport().on(/getPricing/, fixture('namecheap', 'get-pricing-com'));
    const catalog = await adapter.catalog(adapterContext(t, creds));
    expect(new URL(t.requests[0]!.url).searchParams.get('ProductType')).toBe('DOMAIN');
    expect(catalog.entries[0]).toMatchObject({
      suffix: 'com',
      currency: 'USD',
      registration: { amount: '11.28', years: 1 },
      renewal: { amount: '15.88' },
      transfer: { amount: '11.28' },
      promotional: true,
    });
  });

  it('checks an exact name and quotes a standard name from the TLD price', async () => {
    const t = new FakeTransport()
      .on(/domains.check/, fixture('namecheap', 'check-available', { domain: DOMAIN.ascii }))
      .on(/getPricing/, fixture('namecheap', 'get-pricing-com'));
    const quote = await adapter.quote(adapterContext(t, creds), DOMAIN);
    expect(new URL(t.requests[0]!.url).searchParams.get('DomainList')).toBe(DOMAIN.ascii);
    expect(new URL(t.requests[1]!.url).searchParams.get('ProductName')).toBe('com');
    expect(quote.check?.status).toBe('available');
    expect(quote.offers[0]).toMatchObject({ kind: 'exact_quote', registration: { amount: '11.28' }, premium: { status: 'not_premium' } });
    // A zero IcannFee is "not reported", never a free fee.
    expect(quote.offers[0]!.fees.icann).toBeNull();
  });

  it('uses premium prices from domains.check for premium names', async () => {
    const t = new FakeTransport()
      .on(/domains.check/, fixture('namecheap', 'check-premium', { domain: DOMAIN.ascii }))
      .on(/getPricing/, fixture('namecheap', 'get-pricing-com'));
    const offer = (await adapter.quote(adapterContext(t, creds), DOMAIN)).offers[0]!;
    expect(offer.premium).toEqual({ status: 'confirmed', registration: '13000.00', renewal: '13000.00' });
    expect(offer.registration.amount).toBe('13000.00');
  });

  it('reports unavailable names without a price', async () => {
    const t = new FakeTransport().on(/domains.check/, fixture('namecheap', 'check-unavailable', { domain: DOMAIN.ascii }));
    expect((await adapter.check(adapterContext(t, creds), DOMAIN)).status).toBe('unavailable');
  });
});

describe('GoDaddy adapter', () => {
  const creds = { pat: 'gd_pat_fixture_0001' };
  const adapter = new GoDaddyAdapter();

  it('tests the PAT by listing owned domains (no candidate name)', async () => {
    const t = new FakeTransport().on(/domain-names/, fixture('godaddy', 'domain-names'));
    await adapter.testCredentials(adapterContext(t, creds));
    expect(t.requests[0]).toMatchObject({ method: 'GET', url: 'https://api.godaddy.com/v3/domains/domain-names?pageSize=1' });
    expect(t.requests[0]!.headers?.Authorization).toBe(`Bearer ${creds.pat}`);
  });

  it('checks with ACCURACY and parses minor-unit per-term prices', async () => {
    const t = new FakeTransport().on(/check-availability/, fixture('godaddy', 'availability-available', { domain: DOMAIN.ascii }));
    const quote = await adapter.quote(adapterContext(t, creds), DOMAIN);
    const url = new URL(t.requests[0]!.url);
    expect(url.pathname).toBe('/v3/domains/check-availability');
    expect(url.searchParams.get('domain')).toBe(DOMAIN.ascii);
    expect(url.searchParams.get('optimizeFor')).toBe('ACCURACY');
    expect(quote.check?.status).toBe('available');
    expect(quote.offers[0]).toMatchObject({
      currency: 'USD',
      registration: { amount: '11.99', years: 1 },
      renewal: { amount: '22.99', years: 1 },
      minYears: 1,
      premium: { status: 'not_premium' },
    });
  });

  it('keeps purchase fees and premium inventory', async () => {
    const t = new FakeTransport().on(/check-availability/, fixture('godaddy', 'availability-premium', { domain: DOMAIN.ascii }));
    const offer = (await adapter.quote(adapterContext(t, creds), DOMAIN)).offers[0]!;
    expect(offer.premium).toEqual({ status: 'confirmed', registration: '2500.00', renewal: '60.00' });
    expect(offer.fees.other).toEqual([{ label: 'ONE_TIME_PREMIUM_DOMAIN_PURCHASE', amount: '15.00' }]);
  });

  it('keeps a fee in another currency out of totals instead of adding it unconverted (audit 8)', () => {
    const offer = godaddyOffer({
      domain: DOMAIN.ascii,
      available: true,
      definitive: true,
      inventory: 'REGISTRY',
      error: null,
      prices: [
        {
          term: 'YEAR',
          period: 1,
          price: { currencyCode: 'USD', value: 1000 },
          renewalPrice: { currencyCode: 'USD', value: 1000 },
          fees: [
            { type: 'ICANN', fee: { currencyCode: 'EUR', value: 200 } },
            { type: 'SETUP', fee: { currencyCode: 'USD', value: 50 } },
          ],
        },
      ],
    })!;
    expect(offer.currency).toBe('USD');
    expect(offer.fees.other).toEqual([
      { label: 'ICANN (EUR 2.00, not converted to USD)', amount: null },
      { label: 'SETUP', amount: '0.50' },
    ]);
    const row = computeRow({ ...offer, id: '11111111-1111-4111-8111-111111111111', providerId: 'godaddy', domain: DOMAIN.ascii, suffix: 'com', observedAt: '2026-10-05T12:00:00.000Z', staleAt: '2026-10-05T12:15:00.000Z', freshness: 'fresh', destination: null }, false, {
      domain: DOMAIN.ascii,
      providerId: 'godaddy',
      path: 'new_registration',
      horizonYears: 1,
      currency: null,
      fxRates: [],
      destination: null,
    });
    // USD 10 plus the USD 0.50 fee; the EUR fee stays unknown, so the row is a subtotal, never USD 12.
    expect(row).toMatchObject({ currency: 'USD', initialCommitment: '10.50', horizonTotal: '10.50', subtotalOnly: true });
    expect(row.missing).toContain('fees');
  });

  it('treats per-item errors as unknown and 401 as auth', async () => {
    const t = new FakeTransport().on(/check-availability/, fixture('godaddy', 'availability-error', { domain: DOMAIN.ascii }));
    expect((await adapter.check(adapterContext(t, creds), DOMAIN)).status).toBe('unknown');
    const t2 = new FakeTransport().on(/check-availability/, fixture('godaddy', 'unauthorized'));
    expect((await rejects(adapter.check(adapterContext(t2, creds), DOMAIN))).kind).toBe('auth');
  });

  it('states unavailable names', async () => {
    const t = new FakeTransport().on(/check-availability/, fixture('godaddy', 'availability-unavailable', { domain: DOMAIN.ascii }));
    const quote = await adapter.quote(adapterContext(t, creds), DOMAIN);
    expect(quote.check?.status).toBe('unavailable');
    expect(quote.offers).toEqual([]);
  });
});

describe('Cloudflare adapter', () => {
  const creds = { accountId: 'acc0123456789', apiToken: 'cf_token_fixture_0001' };
  const adapter = new CloudflareAdapter();

  it('pages through extensions with the cursor (suffixes only, no prices)', async () => {
    const t = new FakeTransport()
      .on((r) => r.url.includes('/registrar/extensions') && r.url.includes('cursor=c2'), fixture('cloudflare', 'extensions-page2'))
      .on(/registrar\/extensions/, fixture('cloudflare', 'extensions-page1'));
    const catalog = await adapter.catalog(adapterContext(t, creds));
    expect(catalog.suffixes).toEqual(['com', 'co.uk', 'dev']);
    expect(catalog.entries).toEqual([]);
    expect(t.requests[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc0123456789/registrar/extensions?per_page=50');
    expect(t.requests[0]!.headers?.Authorization).toBe(`Bearer ${creds.apiToken}`);
  });

  it('posts domain-check and parses decimal costs', async () => {
    const t = new FakeTransport().on(/domain-check/, fixture('cloudflare', 'check', { domain: DOMAIN.ascii }));
    const quote = await adapter.quote(adapterContext(t, creds), DOMAIN);
    expect(t.requests[0]).toMatchObject({ method: 'POST', url: 'https://api.cloudflare.com/client/v4/accounts/acc0123456789/registrar/domain-check' });
    expect(JSON.parse(t.requests[0]!.body!)).toEqual({ domains: [DOMAIN.ascii] });
    expect(quote.offers[0]).toMatchObject({ currency: 'USD', registration: { amount: '8.57' }, renewal: { amount: '8.57' }, premium: { status: 'not_premium' } });
  });

  it('maps premium and unsupported extensions honestly', async () => {
    const t = new FakeTransport().on(/domain-check/, fixture('cloudflare', 'check-premium', { domain: DOMAIN.ascii }));
    expect(await adapter.check(adapterContext(t, creds), DOMAIN)).toMatchObject({ status: 'restricted', premium: true });
    const t2 = new FakeTransport().on(/domain-check/, fixture('cloudflare', 'check-unsupported', { domain: DOMAIN.ascii }));
    expect((await rejects(adapter.check(adapterContext(t2, creds), DOMAIN))).kind).toBe('unsupported');
  });

  it('checks transfers without ever sending an auth code', async () => {
    const t = new FakeTransport().on(/domain-transfer-check/, fixture('cloudflare', 'transfer', { domain: DOMAIN.ascii }));
    const result = await adapter.transfer(adapterContext(t, creds), DOMAIN);
    expect(JSON.parse(t.requests[0]!.body!)).toEqual({ domains: [{ domain_name: DOMAIN.ascii }] });
    expect(result.offers[0]).toMatchObject({ purchasePath: 'transfer', transfer: { amount: '8.57', includesYears: 1 }, renewal: { amount: '10.11' } });
    const t2 = new FakeTransport().on(/domain-transfer-check/, fixture('cloudflare', 'transfer-not-transferable', { domain: DOMAIN.ascii }));
    const blocked = await adapter.transfer(adapterContext(t2, creds), DOMAIN);
    expect(blocked.offers).toEqual([]);
    expect(blocked.reason.message).toContain('invalid_auth_code');
  });

  it('maps 403 to auth and 429 to rate_limited with retry-after', async () => {
    const t = new FakeTransport().on(/domain-check/, fixture('cloudflare', 'forbidden'));
    expect((await rejects(adapter.check(adapterContext(t, creds), DOMAIN))).kind).toBe('auth');
    const t2 = new FakeTransport().on(/domain-check/, fixture('cloudflare', 'rate-limited'));
    const error = await rejects(adapter.check(adapterContext(t2, creds), DOMAIN));
    expect(error).toMatchObject({ kind: 'rate_limited', extras: { retryAt: '2026-10-05T12:02:00.000Z' } });
  });
});

describe('Spaceship adapter', () => {
  const creds = { apiKey: 'ss_key_fixture_0001', apiSecret: 'ss_secret_fixture_0001' };
  const adapter = new SpaceshipAdapter();

  it('tests with the domain list and sends both key headers', async () => {
    const t = new FakeTransport().on(/\/domains\?take=1/, fixture('spaceship', 'domains-list'));
    await adapter.testCredentials(adapterContext(t, creds));
    expect(t.requests[0]).toMatchObject({ method: 'GET', url: 'https://spaceship.dev/api/v1/domains?take=1&skip=0' });
    expect(t.requests[0]!.headers).toMatchObject({ 'X-API-Key': creds.apiKey, 'X-API-Secret': creds.apiSecret });
  });

  it('confirms availability; a standard name has no API price', async () => {
    const t = new FakeTransport().on(/\/available$/, fixture('spaceship', 'available', { domain: DOMAIN.ascii }));
    const quote = await adapter.quote(adapterContext(t, creds), DOMAIN);
    expect(t.requests[0]!.url).toBe(`https://spaceship.dev/api/v1/domains/${DOMAIN.ascii}/available`);
    expect(quote.check?.status).toBe('available');
    expect(quote.offers).toEqual([]);
  });

  it('quotes premium operation prices', async () => {
    const t = new FakeTransport().on(/\/available$/, fixture('spaceship', 'premium', { domain: DOMAIN.ascii }));
    const offer = (await adapter.quote(adapterContext(t, creds), DOMAIN)).offers[0]!;
    // The term of operation prices is undocumented: they stay premium amounts and never form a total.
    expect(offer).toMatchObject({ registration: { amount: null }, renewal: { amount: null }, premium: { status: 'confirmed', registration: '10.99', renewal: null } });
    expect(offer.source.label).toContain('register 10.99, renew 10.99 USD');
  });

  it('keeps an undocumented result value unknown rather than taken', async () => {
    const t = new FakeTransport().on(/\/available$/, fixture('spaceship', 'undocumented-result', { domain: DOMAIN.ascii }));
    expect((await adapter.check(adapterContext(t, creds), DOMAIN)).status).toBe('unknown');
  });
});

describe('NameSilo adapter', () => {
  const creds = { apiKey: 'nsfixturekey0001' };
  const adapter = new NameSiloAdapter();

  it('uses /apibatch with version, xml type and key query parameters', async () => {
    const t = new FakeTransport().on(/getPrices/, fixture('namesilo', 'get-prices'));
    const catalog = await adapter.catalog(adapterContext(t, creds));
    const url = new URL(t.requests[0]!.url);
    expect(url.origin + url.pathname).toBe('https://www.namesilo.com/apibatch/getPrices');
    expect(Object.fromEntries(url.searchParams)).toEqual({ version: '1', type: 'xml', key: creds.apiKey });
    expect(catalog.entries.map((e) => [e.suffix, e.registration.amount, e.renewal.amount, e.transfer.amount])).toEqual([
      ['com', '12.00', '11.95', '10.40'],
      ['io', '34.95', '39.95', '34.95'],
    ]);
  });

  it('reads availability buckets and the price attribute', async () => {
    const t = new FakeTransport().on(/checkRegisterAvailability/, fixture('namesilo', 'check', { domain: DOMAIN.ascii }));
    const quote = await adapter.quote(adapterContext(t, creds), DOMAIN);
    expect(new URL(t.requests[0]!.url).searchParams.get('domains')).toBe(DOMAIN.ascii);
    expect(quote.check?.status).toBe('available');
    expect(quote.offers[0]).toMatchObject({ registration: { amount: '11.05' }, renewal: { amount: null }, premium: { status: 'unknown' } });
    expect((await adapter.check(adapterContext(t, creds), name('example.com'))).status).toBe('unavailable');
  });

  it('reports a key error from the reply detail without the key', async () => {
    const t = new FakeTransport().on(/getPrices/, fixture('namesilo', 'invalid-key'));
    const error = await rejects(adapter.testCredentials(adapterContext(t, creds)));
    expect(error.kind).toBe('auth');
    expect(error.message).not.toContain(creds.apiKey);
  });
});

describe('Name.com adapter', () => {
  const creds = { username: 'fixtureuser', apiToken: 'namecom_token_fixture_0001' };
  const adapter = new NameComAdapter();
  const basic = `Basic ${Buffer.from(`${creds.username}:${creds.apiToken}`).toString('base64')}`;

  it('tests with GET /core/v1/hello using basic auth', async () => {
    const t = new FakeTransport().on(/\/hello$/, fixture('namecom', 'hello'));
    await adapter.testCredentials(adapterContext(t, creds));
    expect(t.requests[0]).toMatchObject({ method: 'GET', url: 'https://api.name.com/core/v1/hello' });
    expect(t.requests[0]!.headers?.Authorization).toBe(basic);
  });

  it('pages tldpricing and skips unsupported products', async () => {
    const t = new FakeTransport()
      .on((r) => r.url.includes('/tldpricing') && r.url.includes('page=2'), fixture('namecom', 'tldpricing-page2'))
      .on(/\/tldpricing/, fixture('namecom', 'tldpricing-page1'));
    const catalog = await adapter.catalog(adapterContext(t, creds));
    expect(new URL(t.requests[0]!.url).searchParams.get('duration')).toBe('1');
    expect(catalog.suffixes).toEqual(['com', 'app', 'si']);
    const app = catalog.entries.find((e) => e.suffix === 'app')!;
    expect(app.registration.amount).toBeNull();
    expect(catalog.entries.find((e) => e.suffix === 'com')).toMatchObject({ registration: { amount: '10.99' }, promotional: true });
  });

  it('quotes registrations with checkAvailability then getPricing (literal colon paths)', async () => {
    const t = new FakeTransport()
      .on(/domains:checkAvailability/, fixture('namecom', 'check-registration', { domain: DOMAIN.ascii }))
      .on(/:getPricing/, fixture('namecom', 'get-pricing'));
    const quote = await adapter.quote(adapterContext(t, creds), DOMAIN);
    expect(t.requests[0]).toMatchObject({ method: 'POST', url: 'https://api.name.com/core/v1/domains:checkAvailability' });
    expect(JSON.parse(t.requests[0]!.body!)).toEqual({ domainNames: [DOMAIN.ascii] });
    expect(t.requests[1]!.url).toBe(`https://api.name.com/core/v1/domains/${DOMAIN.ascii}:getPricing?years=1`);
    expect(quote.offers[0]).toMatchObject({ registration: { amount: '10.99' }, renewal: { amount: '12.99' }, transfer: { amount: '10.99' }, premium: { status: 'not_premium' } });
  });

  it('separates aftermarket acquisitions from new registrations', async () => {
    const t = new FakeTransport().on(/domains:checkAvailability/, fixture('namecom', 'check-aftermarket', { domain: DOMAIN.ascii }));
    const quote = await adapter.quote(adapterContext(t, creds), DOMAIN);
    expect(quote.check?.status).toBe('unavailable');
    expect(quote.offers[0]).toMatchObject({ purchasePath: 'aftermarket', registration: { amount: '2500.00' } });
    const listing = await adapter.aftermarket(adapterContext(t, creds), DOMAIN);
    expect(listing).toMatchObject({ status: 'fixed_price', price: { amount: '2500.00', currency: 'USD' } });
  });

  it('reads transfer price and maps 422 to unsupported', async () => {
    const t = new FakeTransport().on(/:getPricing/, fixture('namecom', 'get-pricing'));
    expect((await adapter.transfer(adapterContext(t, creds), DOMAIN)).offers[0]).toMatchObject({ transfer: { amount: '10.99', includesYears: null } });
    const t2 = new FakeTransport().on(/checkAvailability/, fixture('namecom', 'unprocessable'));
    expect((await rejects(adapter.check(adapterContext(t2, creds), DOMAIN))).kind).toBe('unsupported');
  });
});

describe('Dynadot adapter', () => {
  const creds = { apiKey: 'dynadot_key_fixture_0001' };
  const adapter = new DynadotAdapter();

  it('searches with show_price and a Bearer key', async () => {
    const t = new FakeTransport().on(/\/search\?/, fixture('dynadot', 'search-available', { domain: DOMAIN.ascii }));
    const quote = await adapter.quote(adapterContext(t, creds), DOMAIN);
    expect(t.requests[0]!.url).toBe(`https://api.dynadot.com/restful/v2/domains/${DOMAIN.ascii}/search?show_price=true&currency=usd`);
    expect(t.requests[0]!.headers?.Authorization).toBe(`Bearer ${creds.apiKey}`);
    expect(quote.offers[0]).toMatchObject({ currency: 'USD', registration: { amount: '9.99', years: 1 }, renewal: { amount: '11.99' }, premium: { status: 'not_premium' } });
  });

  it('parses the official search example ("No", premium yes) as unavailable', async () => {
    const t = new FakeTransport().on(/\/search\?/, fixture('dynadot', 'search-official-example'));
    const quote = await adapter.quote(adapterContext(t, creds), name('domain1.com'));
    expect(quote.check).toMatchObject({ status: 'unavailable', premium: true });
    expect(quote.offers).toEqual([]);
  });

  it('keeps undocumented catalog list prices unknown and maps "--" to null', async () => {
    const t = new FakeTransport().on(/get_tld_price/, fixture('dynadot', 'tld-price-official-example'));
    const catalog = await adapter.catalog(adapterContext(t, creds));
    expect(catalog.entries[0]).toMatchObject({ suffix: 'com', registration: { amount: null }, transfer: { amount: null, includesYears: null }, minYears: 1 });
  });

  it('reads listings and maps 401/429', async () => {
    const t = new FakeTransport().on(/aftermarket\/listings/, fixture('dynadot', 'listing-official-example'));
    expect(await adapter.aftermarket(adapterContext(t, creds), name('example.com'))).toMatchObject({ status: 'fixed_price', price: { amount: '19.99', currency: 'USD' } });
    const t2 = new FakeTransport().on(/\/search\?/, fixture('dynadot', 'unauthorized'));
    expect((await rejects(adapter.check(adapterContext(t2, creds), DOMAIN))).kind).toBe('auth');
    const t3 = new FakeTransport().on(/\/search\?/, fixture('dynadot', 'rate-limited'));
    expect((await rejects(adapter.check(adapterContext(t3, creds), DOMAIN))).kind).toBe('rate_limited');
  });
});

describe('Hostinger adapter', () => {
  const creds = { apiToken: 'hostinger_token_fixture_0001' };
  const adapter = new HostingerAdapter();

  it('checks availability with label and TLD (no price in the response)', async () => {
    const t = new FakeTransport().on(/availability$/, fixture('hostinger', 'availability', { domain: DOMAIN.ascii }));
    const check = await adapter.check(adapterContext(t, creds), DOMAIN);
    expect(t.requests[0]).toMatchObject({ method: 'POST', url: 'https://developers.hostinger.com/api/domains/v1/availability' });
    expect(JSON.parse(t.requests[0]!.body!)).toEqual({ domain: 'xq7mz9brandtest', tlds: ['com'], with_alternatives: false });
    expect(check).toMatchObject({ status: 'available', premium: null });
  });

  it('combines availability with the catalog only as a published, premium-unknown price', async () => {
    const t = new FakeTransport()
      .on(/availability$/, fixture('hostinger', 'availability', { domain: DOMAIN.ascii }))
      .on(/billing\/v1\/catalog/, fixture('hostinger', 'catalog'));
    const quote = await adapter.quote(adapterContext(t, creds), DOMAIN);
    expect(new URL(t.requests[1]!.url).searchParams.get('name')).toBe('.COM*');
    expect(quote.offers[0]).toMatchObject({
      kind: 'published',
      currency: 'USD',
      registration: { amount: '9.99', years: 1 },
      // Whether the regular catalog price is the renewal price is undocumented.
      renewal: { amount: null, years: 1 },
      premium: { status: 'unknown' },
    });
    expect(quote.offers[0]!.source.label).toContain('regular price 17.99 USD');
  });

  it('lists only domain catalog items and maps 401 to auth', async () => {
    const t = new FakeTransport().on(/billing\/v1\/catalog/, fixture('hostinger', 'catalog'));
    expect((await adapter.catalog(adapterContext(t, creds))).suffixes).toEqual(['com']);
    const t2 = new FakeTransport().on(/billing\/v1\/catalog/, fixture('hostinger', 'unauthorized'));
    expect((await rejects(adapter.testCredentials(adapterContext(t2, creds)))).kind).toBe('auth');
  });
});

describe('review regressions', () => {
  it('GoDaddy rejects an answer for a different domain', async () => {
    const t = new FakeTransport().on(/check-availability/, fixture('godaddy', 'availability-available', { domain: 'google.com' }));
    const error = await rejects(new GoDaddyAdapter().check(adapterContext(t, { pat: 'gd_pat_fixture_0001' }), DOMAIN));
    expect(error.kind).toBe('bad_response');
  });

  it('HTTP auth and server statuses keep their meaning under error envelopes', async () => {
    const nc = new FakeTransport().on(/xml.response/, { ...fixture('namecheap', 'error-api-key'), status: 503 });
    expect((await rejects(new NamecheapAdapter().check(adapterContext(nc, { apiUser: 'u', apiKey: 'nc_key_000001', clientIp: '198.51.100.7' }), DOMAIN))).kind).toBe('transient');
    const pb = new FakeTransport().on(/checkDomain/, { status: 401, headers: {}, body: JSON.stringify({ status: 'ERROR', code: 'SOMETHING_NEW', message: 'no' }) });
    expect((await rejects(new PorkbunAdapter().check(adapterContext(pb, { apiKey: 'pk1_x0001', secretApiKey: 'sk1_x0001' }), DOMAIN))).kind).toBe('auth');
  });

  it('malformed catalogs are bad responses, not empty successes', async () => {
    const dy = new FakeTransport().on(/get_tld_price/, { status: 200, headers: {}, body: JSON.stringify({ code: 200, message: 'Success', data: { unexpected: true } }) });
    expect((await rejects(new DynadotAdapter().catalog(adapterContext(dy, { apiKey: 'dyn_key_0001' })))).kind).toBe('bad_response');
    const cf = new FakeTransport().on(/extensions/, { status: 200, headers: {}, body: JSON.stringify({ success: true, errors: [], messages: [] }) });
    expect((await rejects(new CloudflareAdapter().catalog(adapterContext(cf, { accountId: 'a', apiToken: 'cf_tok_0001' })))).kind).toBe('bad_response');
  });

  it('a missing Dynadot listing and a Name.com backorder stay unknown', async () => {
    const dy = new FakeTransport().on(/aftermarket\/listings/, { status: 200, headers: {}, body: JSON.stringify({ code: 200, message: 'Success', data: {} }) });
    expect((await new DynadotAdapter().aftermarket(adapterContext(dy, { apiKey: 'dyn_key_0001' }), DOMAIN)).status).toBe('unknown');
    const nm = new FakeTransport().on(/checkAvailability/, {
      status: 200,
      headers: {},
      body: JSON.stringify({ results: [{ domainName: DOMAIN.ascii, purchasable: true, purchaseType: 'backorder', purchasePrice: 69 }] }),
    });
    expect((await new NameComAdapter().aftermarket(adapterContext(nm, { username: 'u', apiToken: 'nm_tok_0001' }), DOMAIN)).status).toBe('unknown');
  });

  it('Hostinger catalog items without a first-period price get no registration price', () => {
    const body = JSON.parse(fixture('hostinger', 'catalog').body);
    delete body[0].prices[0].first_period_price;
    delete body[0].prices[1].first_period_price;
    const parsed = parseHostingerCatalog(body);
    expect(parsed.suffixes).toEqual(['com']);
    expect(parsed.entries).toEqual([]);
  });

  it('an XML document with a second root is malformed', async () => {
    const body = fixture('namecheap', 'check-available', { domain: DOMAIN.ascii }).body + '<ApiResponse Status="ERROR"><Errors><Error Number="1">x</Error></Errors></ApiResponse>';
    const t = new FakeTransport().on(/domains.check/, { status: 200, headers: {}, body });
    expect((await rejects(new NamecheapAdapter().check(adapterContext(t, { apiUser: 'u', apiKey: 'nc_key_000001', clientIp: '198.51.100.7' }), DOMAIN))).kind).toBe('bad_response');
  });
});

describe('secret scrubbing', () => {
  it('removes configured values and common credential shapes but keeps ordinary text', () => {
    expect(scrubSecrets('key a/b+c=d123 and a%2Fb%2Bc%3Dd123', ['a/b+c=d123'])).toBe('key [redacted] and [redacted]');
    expect(scrubSecrets('https://bob:pw123456@host.test/x?apikey=K1&ApiUser=me&page=2#token=T9')).toBe(
      'https://[redacted]@host.test/x?apikey=[redacted]&ApiUser=[redacted]&page=2#token=[redacted]',
    );
    expect(scrubSecrets('Authorization: Bearer abc.DEF-123_xyz')).toBe('Authorization: Bearer [redacted]');
    expect(scrubSecrets('Basic dXNlcjpwYXNzd29yZA==')).toBe('Basic [redacted]');
    expect(scrubSecrets('sso-key KEY123:SECRET456 sent')).toBe('sso-key [redacted] sent');
    expect(scrubSecrets('keys pk1_abcdef123 and sk1_zyxwvu987')).toBe('keys [redacted] and [redacted]');
    expect(scrubSecrets(`jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl end`)).toBe('jwt [redacted] end');
    for (const text of ['Basic registration', 'Token expired', 'monkey=1', 'GoDaddy v3 check-availability (indicative, cached)', 'https://porkbun.com/checkout/search?q=example.com']) {
      expect(scrubSecrets(text)).toBe(text);
    }
  });
});

describe('xml reader', () => {
  it('rejects malformed attributes, duplicates and text outside the root', () => {
    expect(() => parseXml('<r a="1"b="2"/>')).toThrow();
    expect(() => parseXml('<r a="1" a="2"/>')).toThrow();
    expect(() => parseXml('<r/>trailing')).toThrow();
    expect(() => parseXml('<r/><r/>')).toThrow();
    expect(parseXml('<?xml version="1.0"?>\n<r a="1 &amp; 2" b=\'x\'><c>&#65;</c></r>\n')).toMatchObject({ name: 'r', attrs: { a: '1 & 2', b: 'x' }, children: [{ name: 'c', text: 'A' }] });
  });
});

describe('manifests', () => {
  it('cover the nine named providers with honest capability levels', () => {
    expect(REGISTRAR_MANIFESTS.map((m) => m.id).sort()).toEqual(
      ['cloudflare', 'dynadot', 'godaddy', 'hostinger', 'namecheap', 'namecom', 'namesilo', 'porkbun', 'spaceship'].sort(),
    );
    for (const m of REGISTRAR_MANIFESTS) {
      for (const [name, cap] of Object.entries(m.capabilities)) {
        // No live keys exist: nothing authenticated can be live_tested.
        if (cap.requiresCredentials) expect(cap.level, `${m.id}.${name}`).not.toBe('live_tested');
        if (cap.level !== 'unsupported') expect(cap.source, `${m.id}.${name}`).toBeTruthy();
      }
      // Storefront templates were not opened.
      expect(m.purchaseLink?.verifiedAt ?? null).toBeNull();
      for (const f of m.credentialFields) expect(f.envVar).toMatch(/^DOMAIN_SCOUT_[A-Z0-9_]+$/);
    }
    expect(REGISTRAR_MANIFESTS.find((m) => m.id === 'porkbun')!.credentialFields.map((f) => f.envVar)).toEqual([
      'DOMAIN_SCOUT_PORKBUN_API_KEY',
      'DOMAIN_SCOUT_PORKBUN_SECRET_API_KEY',
    ]);
  });
});
