import { DOMAIN_HUNTER_REGISTRARS, cap, field, unsupported, type ProviderManifest } from './manifest.js';

/*
 * The nine named providers. Sources are official documentation read on 2026-10-05 (see
 * REFERENCES.md and the provider research report). No provider API was called and no live keys
 * exist, so authenticated capabilities are at most fixture_tested. Storefront search templates come
 * from the pinned Domain Hunter reference; their prefill behavior was not confirmed or opened, so
 * they stay documented with verifiedAt null.
 */

const PORKBUN_SPEC = 'https://porkbun.com/api/json/v3/spec';
/** Time of the authorized live catalog fetch (test/live/catalog.live.spec.ts). */
const PORKBUN_LIVE_FETCHED_AT = '2026-10-05T14:07:00.133Z';
const NAMECHEAP_CHECK = 'https://www.namecheap.com/support/api/methods/domains/check/';
const NAMECHEAP_PRICING = 'https://www.namecheap.com/support/api/methods/users/get-pricing/';
const GODADDY_V3 = 'https://developer.godaddy.com/openapi/domains-v3.json';
const CLOUDFLARE_CHECK = 'https://developers.cloudflare.com/api/resources/registrar/methods/check/';
const CLOUDFLARE_TRANSFER = 'https://developers.cloudflare.com/api/resources/registrar/methods/transfer_check/';
const CLOUDFLARE_EXTENSIONS = 'https://developers.cloudflare.com/api/resources/registrar/subresources/extensions/methods/list/';
const SPACESHIP_DOCS = 'https://docs.spaceship.dev/';
const NAMESILO_WALKTHROUGH = 'https://www.namesilo.com/blog/en/building-a-domain-search-tool-with-a-registrar-api';
const NAMECOM_CHECK = 'https://docs.name.com/api/v1/reference/domains/check-availability';
const NAMECOM_PRICING = 'https://docs.name.com/api/v1/reference/domains/get-pricing-for-domain';
const NAMECOM_TLD_PRICING = 'https://docs.name.com/api/v1/reference/tld-pricing/tld-price-list';
const DYNADOT_DOCS = 'https://www.dynadot.com/domain/api-document';
const HOSTINGER_AVAILABILITY = 'https://github.com/hostinger/api-python-sdk/blob/main/docs/DomainsAvailabilityApi.md';
const HOSTINGER_CATALOG = 'https://github.com/hostinger/api-python-sdk/blob/main/docs/BillingCatalogApi.md';

function searchLink(template: string) {
  return { template, kind: 'search' as const, source: DOMAIN_HUNTER_REGISTRARS, verifiedAt: null };
}

const linkNote =
  'Search template from the Domain Hunter reference; the provider does not document it and it was not opened, so prefill behavior is unconfirmed.';

export const REGISTRAR_MANIFESTS: ProviderManifest[] = [
  {
    id: 'hostinger',
    name: 'Hostinger',
    kind: 'registrar',
    website: 'https://www.hostinger.com/domains',
    setupUrl: 'https://hpanel.hostinger.com/profile/api',
    apiHost: 'developers.hostinger.com',
    docsUrl: 'https://docs.hostinger.com/api-reference/overview',
    credentialFields: [field('hostinger', 'apiToken', 'API token', { help: 'hPanel > Profile > API. Tokens inherit your permissions and can expire.' })],
    accountRequirements: ['A Hostinger account with an API token created in hPanel (Profile > API)'],
    rateLimits: '90 requests per minute per user by default (also documented for availability); honor 429 Retry-After.',
    purchaseLink: searchLink('https://www.hostinger.com/domain-checker?domain={domain}'),
    capabilities: {
      purchaseLink: cap('documented', false, DOMAIN_HUNTER_REGISTRARS, linkNote, null),
      catalog: cap(
        'documented',
        true,
        HOSTINGER_CATALOG,
        'Authenticated billing catalog (category DOMAIN). Items carry first_period_price and price in cents per period. first_period_price is recorded as the first-term price; Hostinger does not document whether price is the renewal price, so renewal stays unknown and the regular price is only labeled.',
      ),
      exactCheck: cap('fixture_tested', true, HOSTINGER_AVAILABILITY, 'Availability only: the response has no price, premium, term or fee fields.'),
      quote: cap(
        'documented',
        true,
        HOSTINGER_AVAILABILITY,
        'No exact-name quote exists. A quote combines availability with the billing catalog price, recorded as a published price with unknown premium status.',
      ),
      transfer: unsupported('No documented exact-name transfer price.'),
      aftermarket: unsupported('No documented aftermarket listing API.'),
    },
  },
  {
    id: 'dynadot',
    name: 'Dynadot',
    kind: 'registrar',
    website: 'https://www.dynadot.com',
    setupUrl: 'https://www.dynadot.com/account/domain/setting/api.html',
    apiHost: 'api.dynadot.com',
    docsUrl: DYNADOT_DOCS,
    credentialFields: [field('dynadot', 'apiKey', 'API key', { help: 'Tools > API. Search and price commands use the key as a Bearer token; no signature is required for them.' })],
    accountRequirements: [
      'Generate an API key under Tools > API (the RESTful v2 API is labeled beta)',
      'Allowed IPs can be configured on the API settings page',
    ],
    rateLimits: 'Regular price level: 1 thread, 60 requests per minute; Bulk: 5 threads, 600 per minute; Super Bulk: 35 threads, 6000 per minute.',
    purchaseLink: searchLink('https://www.dynadot.com/domain/search.html?domain={domain}'),
    capabilities: {
      purchaseLink: cap('documented', false, DOMAIN_HUNTER_REGISTRARS, linkNote, null),
      catalog: cap(
        'documented',
        true,
        DYNADOT_DOCS,
        'GET /restful/v2/domains/get_tld_price. The element format of all_years_register_price and all_years_renew_price is not shown in the documented example, so parsed prices are unverified.',
      ),
      exactCheck: cap('fixture_tested', true, DYNADOT_DOCS, 'GET /restful/v2/domains/{domain}/search; premium is yes, no or unknown.'),
      quote: cap('fixture_tested', true, DYNADOT_DOCS, 'Search with show_price=true returns per-term registration, renewal and transfer prices only for available names.'),
      transfer: unsupported('Search returns prices only for available names, so registered names get no exact transfer price; the catalog lists TLD transfer prices.'),
      aftermarket: cap(
        'documented',
        true,
        DYNADOT_DOCS,
        'GET /restful/v2/aftermarket/listings/{domain}. The response for a name that is not listed is not documented.',
      ),
    },
  },
  {
    id: 'porkbun',
    name: 'Porkbun',
    kind: 'registrar',
    website: 'https://porkbun.com',
    setupUrl: 'https://porkbun.com/account/api',
    apiHost: 'api.porkbun.com',
    docsUrl: 'https://porkbun.com/api/json/v3/documentation',
    credentialFields: [
      field('porkbun', 'apiKey', 'API key', { help: 'Starts with pk1_. Create it at porkbun.com/account/api.' }),
      field('porkbun', 'secretApiKey', 'Secret API key', { help: 'Starts with sk1_.' }),
    ],
    accountRequirements: [
      'Create an API key and secret at porkbun.com/account/api',
      'Keys with an IP or domain allowlist reject other sources (IP_NOT_ALLOWED, DOMAIN_NOT_ALLOWED)',
    ],
    rateLimits: 'Exact checks: 10 per 10 seconds per account by default (configurable per key); bulk checks 200 names per 60 seconds. The public pricing endpoint documents no limit.',
    purchaseLink: searchLink('https://porkbun.com/checkout/search?q={domain}'),
    currency: 'USD',
    capabilities: {
      purchaseLink: cap('documented', false, DOMAIN_HUNTER_REGISTRARS, linkNote, null),
      catalog: cap(
        'live_tested',
        false,
        PORKBUN_SPEC,
        'Keyless GET /pricing/get, fetched live once on 2026-10-05 (911 TLD entries, no names or keys sent; trimmed capture in test fixtures). USD per the documentation; standard prices for the TLD, not exact-name quotes. Coupons are listed but never applied.',
        PORKBUN_LIVE_FETCHED_AT,
      ),
      exactCheck: cap('fixture_tested', true, PORKBUN_SPEC, 'POST /domain/checkDomain/{domain} with key headers.'),
      quote: cap('fixture_tested', true, PORKBUN_SPEC, 'checkDomain returns price, regularPrice, firstYearPromo, premium, minDuration and renewal/transfer prices in USD.'),
      transfer: cap('fixture_tested', true, PORKBUN_SPEC, 'Transfer price from checkDomain additional.transfer; included registration years are not stated.'),
      aftermarket: cap('fixture_tested', true, PORKBUN_SPEC, 'Filtered POST /marketplace/getAll by SLD and TLD; exact matches only. Prices in USD.'),
    },
  },
  {
    id: 'namecheap',
    name: 'Namecheap',
    kind: 'registrar',
    website: 'https://www.namecheap.com',
    setupUrl: 'https://ap.www.namecheap.com/settings/tools/apiaccess/',
    apiHost: 'api.namecheap.com',
    docsUrl: 'https://www.namecheap.com/support/api/intro/',
    credentialFields: [
      field('namecheap', 'apiUser', 'API user', { secret: false, help: 'Your Namecheap username.' }),
      field('namecheap', 'apiKey', 'API key'),
      field('namecheap', 'userName', 'User name', { secret: false, required: false, help: 'Defaults to the API user.' }),
      field('namecheap', 'clientIp', 'Whitelisted client IPv4', { secret: false, help: 'The IPv4 address you whitelisted for API access; requests are sent with it.' }),
    ],
    accountRequirements: [
      'Enable API access under Profile > Tools > Business & Dev Tools > Namecheap API Access',
      'Whitelist at least one IPv4 address',
      'Production access requires one of: 20 domains, a $50 account balance, or $50 spent in the last two years',
    ],
    rateLimits: '50 calls per minute, 700 per hour, 8000 per day per API key.',
    purchaseLink: searchLink('https://namecheap.com/domains/registration/results/?domain={domain}'),
    capabilities: {
      purchaseLink: cap('documented', false, DOMAIN_HUNTER_REGISTRARS, linkNote, null),
      catalog: cap('fixture_tested', true, NAMECHEAP_PRICING, 'users.getPricing ProductType=DOMAIN; account prices (YourPrice) for register, renew and transfer.'),
      exactCheck: cap('fixture_tested', true, NAMECHEAP_CHECK, 'domains.check returns availability, premium flag and premium prices.'),
      quote: cap(
        'fixture_tested',
        true,
        NAMECHEAP_CHECK,
        'domains.check plus users.getPricing for the TLD: premium names use the premium prices; standard names use the account TLD price, which the check confirms applies.',
      ),
      transfer: unsupported('No exact-name transfer price for standard names; the catalog lists TLD transfer prices.'),
      aftermarket: unsupported('No confirmed public marketplace listing API.'),
    },
  },
  {
    id: 'godaddy',
    name: 'GoDaddy',
    kind: 'registrar',
    website: 'https://www.godaddy.com/domains',
    setupUrl: 'https://developer.godaddy.com/en/docs/api-users/auth/how-to',
    apiHost: 'api.godaddy.com',
    docsUrl: 'https://developer.godaddy.com/en/docs/references/rest/domains',
    credentialFields: [field('godaddy', 'pat', 'Personal access token', { help: 'Scope domains.domain:read. Sent as a Bearer token to Domains v3.' })],
    accountRequirements: [
      'Generate a Personal Access Token with the domains.domain:read scope',
      'Discovery is documented as available to any account; listing owned domains (the credential test) may need an owned domain or eligible plan',
    ],
    rateLimits: 'Endpoint guides say 60 requests per minute; the rate guide describes 600 per window of about 23 minutes. RateLimit-* headers are authoritative.',
    purchaseLink: searchLink('https://www.godaddy.com/domainsearch/find?checkAvail=1&domainToCheck={domain}'),
    capabilities: {
      purchaseLink: cap('documented', false, DOMAIN_HUNTER_REGISTRARS, linkNote, null),
      catalog: unsupported('No documented price catalog; the v1 TLD list is not confirmed to accept a PAT and carries no prices.'),
      exactCheck: cap('fixture_tested', true, GODADDY_V3, 'GET /v3/domains/check-availability with optimizeFor=ACCURACY (registry-confirmed when definitive).'),
      quote: cap(
        'fixture_tested',
        true,
        GODADDY_V3,
        'Per-term price, renewal and first-term price in currency minor units, plus purchase fees. GoDaddy calls availability pricing indicative; locked quotes need the purchase flow.',
      ),
      transfer: unsupported('Transfer pricing is not in the v3 check result and no read-only transfer quote is confirmed.'),
      aftermarket: unsupported('Auctions require classic key/secret credentials and use unconfirmed money units.'),
    },
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Registrar',
    kind: 'registrar',
    website: 'https://www.cloudflare.com/products/registrar/',
    setupUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    apiHost: 'api.cloudflare.com',
    docsUrl: 'https://developers.cloudflare.com/registrar/registrar-api/',
    credentialFields: [
      field('cloudflare', 'accountId', 'Account ID', { secret: false }),
      field('cloudflare', 'apiToken', 'API token', { help: 'An account API token with Registrar permission.' }),
    ],
    accountRequirements: [
      'A Cloudflare account ID and an API token with Registrar permission',
      'The Registrar search and registration API is documented as beta',
    ],
    rateLimits: '1200 requests per 5 minutes per user or account token, and 200 per second per IP; honor 429 retry-after.',
    purchaseLink: {
      template: 'https://domains.cloudflare.com/',
      kind: 'search',
      source: 'https://developers.cloudflare.com/registrar/registrar-api/',
      verifiedAt: null,
    },
    capabilities: {
      purchaseLink: cap('documented', false, 'https://developers.cloudflare.com/registrar/registrar-api/', 'Public search entry without an exact-name prefill; registration completes in the dashboard.', null),
      catalog: cap('fixture_tested', true, CLOUDFLARE_EXTENSIONS, 'Supported extensions only (GET /accounts/{id}/registrar/extensions); no prices.'),
      exactCheck: cap('fixture_tested', true, CLOUDFLARE_CHECK, 'Real-time registry check (POST /accounts/{id}/registrar/domain-check).'),
      quote: cap('fixture_tested', true, CLOUDFLARE_CHECK, 'registration_cost (first year) and renewal_cost per year as decimal strings. Premium names are not registrable through this API.'),
      transfer: cap(
        'fixture_tested',
        true,
        CLOUDFLARE_TRANSFER,
        'domain-transfer-check without an auth code (none is ever requested); most TLDs then report not transferable and return no price.',
      ),
      aftermarket: unsupported('No documented aftermarket listing API.'),
    },
  },
  {
    id: 'spaceship',
    name: 'Spaceship',
    kind: 'registrar',
    website: 'https://www.spaceship.com/domains/',
    setupUrl: 'https://www.spaceship.com/application/api-manager/',
    apiHost: 'spaceship.dev',
    docsUrl: SPACESHIP_DOCS,
    credentialFields: [
      field('spaceship', 'apiKey', 'API key', { help: 'API Manager > New API key, with domains:read.' }),
      field('spaceship', 'apiSecret', 'API secret'),
    ],
    accountRequirements: ['Create an API key and secret in the API Manager with the domains:read permission'],
    rateLimits: 'Availability: 30 requests per 30 seconds per user and 5 per 300 seconds per domain; domain list: 300 per 300 seconds.',
    purchaseLink: searchLink('https://spaceship.com/domains/search/?q={domain}'),
    capabilities: {
      purchaseLink: cap('documented', false, DOMAIN_HUNTER_REGISTRARS, linkNote, null),
      catalog: unsupported('No documented price catalog API.'),
      exactCheck: cap(
        'documented',
        true,
        SPACESHIP_DOCS,
        'GET /v1/domains/{domain}/available. Only the value "available" is documented for result; other values are kept as unknown.',
      ),
      quote: cap(
        'documented',
        true,
        SPACESHIP_DOCS,
        'premiumPricing gives premium operation prices only, without a documented term: they are kept as confirmed premium amounts while registration and renewal totals stay unknown, so these offers never rank. Standard prices are not in the API.',
      ),
      transfer: unsupported('Standard transfer prices are published only as HTML.'),
      aftermarket: unsupported('SellerHub lists only the account’s own listings.'),
    },
  },
  {
    id: 'namesilo',
    name: 'NameSilo',
    kind: 'registrar',
    website: 'https://www.namesilo.com',
    setupUrl: 'https://www.namesilo.com/account/api-manager',
    apiHost: 'www.namesilo.com',
    docsUrl: 'https://www.namesilo.com/api-reference',
    credentialFields: [field('namesilo', 'apiKey', 'API key', { help: 'API Manager. The key cannot be retrieved later, so keep a copy.' })],
    accountRequirements: [
      'Generate an API key in the API Manager (available to all users)',
      'Optional IP restriction allows up to five source addresses',
      'Automated use must go through the /apibatch endpoint, which this adapter uses',
    ],
    rateLimits: 'No numeric limits documented; automated repetitive use of /api can be throttled, so the adapter uses /apibatch.',
    purchaseLink: searchLink('https://www.namesilo.com/domain_search.php?domain={domain}'),
    currency: 'USD',
    capabilities: {
      purchaseLink: cap('documented', false, DOMAIN_HUNTER_REGISTRARS, linkNote, null),
      catalog: cap('documented', true, NAMESILO_WALKTHROUGH, 'getPrices XML per TLD (registration, renew, transfer). Only a simplified fragment is documented; the envelope and currency field are unconfirmed (USD assumed from the walkthrough).'),
      exactCheck: cap('documented', true, NAMESILO_WALKTHROUGH, 'checkRegisterAvailability available/unavailable/invalid buckets; complete envelope unconfirmed.'),
      quote: cap('documented', true, NAMESILO_WALKTHROUGH, 'Available names carry a price attribute; premium flag, renewal, term and fees are unconfirmed.'),
      transfer: unsupported('Transfer prices are only TLD-level (catalog).'),
      aftermarket: unsupported('Marketplace operations are mentioned but their contracts are unconfirmed.'),
    },
  },
  {
    id: 'namecom',
    name: 'Name.com',
    kind: 'registrar',
    website: 'https://www.name.com',
    setupUrl: 'https://www.name.com/account/settings/api',
    apiHost: 'api.name.com',
    docsUrl: 'https://docs.name.com/api/v1/overview',
    credentialFields: [
      field('namecom', 'username', 'Username', { secret: false }),
      field('namecom', 'apiToken', 'API token', { help: 'Settings > Security > API Tokens.' }),
    ],
    accountRequirements: [
      'Create an API token under Settings > Security > API Tokens and accept the API agreement',
      'IP whitelisting is optional',
    ],
    rateLimits: '20 requests per second and 3000 per hour per account; honor 429 and X-RateLimit-Reset.',
    purchaseLink: searchLink('https://www.name.com/domain/search/{domain}'),
    currency: 'USD',
    capabilities: {
      purchaseLink: cap('documented', false, DOMAIN_HUNTER_REGISTRARS, linkNote, null),
      catalog: cap('fixture_tested', true, NAMECOM_TLD_PRICING, 'GET /core/v1/tldpricing (account prices, USD, non-premium).'),
      exactCheck: cap('fixture_tested', true, NAMECOM_CHECK, 'POST /core/v1/domains:checkAvailability; non-registration purchase types are aftermarket acquisitions.'),
      quote: cap('fixture_tested', true, NAMECOM_PRICING, 'checkAvailability plus GET /core/v1/domains/{domain}:getPricing?years=1 for registration, renewal and transfer.'),
      transfer: cap('fixture_tested', true, NAMECOM_PRICING, 'transferPrice from getPricing; included registration years are not stated.'),
      aftermarket: cap('fixture_tested', true, NAMECOM_CHECK, 'checkAvailability purchaseType aftermarket_*, expiring or backorder with a flat acquisition price.'),
    },
  },
];
