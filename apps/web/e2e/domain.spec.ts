import { expect, test } from './fixtures';
import { GIB, mockApp } from './app-fixtures';
import { NOW, PROVIDERS, job, mockApi, ok, paged, uuid } from './mock-api';

// The domain page (and the dock beside results) leads with the decision: status, what it costs by
// provider, where to buy, then save and watch. Evidence details wait one click below.

const FREE = `${GIB[0]}.com`;
const CHECKOUT = (provider: string, domain: string) => `https://${provider}.provider.invalid/checkout?domain=${domain}`;

function quote(providerId: string, domain: string, registration: string, renewal: string) {
  return {
    id: uuid(0x7a1),
    providerId,
    domain,
    suffix: 'com',
    purchasePath: 'new_registration',
    kind: 'exact_quote',
    currency: 'USD',
    region: null,
    registration: { amount: registration, years: 1 },
    minYears: null,
    renewal: { amount: renewal, years: 1 },
    transfer: { amount: null, includesYears: null },
    fees: { icann: null, other: [], tax: 'unknown' },
    premium: { status: 'not_premium', registration: null, renewal: null },
    promotion: null,
    observedAt: NOW,
    publishedAt: null,
    quoteExpiresAt: null,
    staleAt: '2099-01-01T00:00:00.000Z',
    freshness: 'fresh',
    source: { label: 'Fixture quote', url: null },
    destination: { url: `https://${providerId}.provider.invalid/cart?domain=${domain}`, kind: 'checkout' },
  };
}

test('a free name leads with its status, prices by provider and the cheapest checkout link', async ({ page }) => {
  await mockApp(page);
  await page.goto(`/domains/${FREE}`);
  await expect(page.getByRole('heading', { level: 1, name: FREE })).toBeVisible();
  await expect(page.getByTestId('domain-status')).toContainText('Not registered');
  await expect(page.getByTestId('buy-cheapest')).toHaveText(/Buy at Porkbun/);
  await expect(page.getByTestId('buy-cheapest')).toHaveAttribute('href', CHECKOUT('porkbun', FREE));
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Watch', exact: true })).toBeVisible();

  const prices = page.getByRole('region', { name: 'Prices' });
  const rows = prices.getByTestId('price-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('Porkbun');
  await expect(rows.first()).toContainText('$10.37');
  // First year, renewal and the three-year estimate side by side.
  await expect(rows.first()).toContainText('$11.08');
  await expect(rows.first()).toContainText('$32.53');
  await expect(rows.nth(1).getByTestId('buy-link')).toHaveAttribute('href', CHECKOUT('dynadot', FREE));
  // Keyless providers can quote here, so exact quotes are one button away.
  await expect(prices.getByRole('button', { name: 'Get exact quotes' })).toBeVisible();
  await expect(page.getByText(/\bAvailable\b/)).toHaveCount(0);
});

test('an exact quote replaces that provider’s published price and reads Quote', async ({ page }) => {
  await mockApp(page);
  await mockApi(page, { 'GET /domains/:name/offers': (_c, p) => paged([quote('dynadot', decodeURIComponent(p.name!), '1.99', '12.99')]) });
  await page.goto(`/domains/${FREE}`);
  const rows = page.getByRole('region', { name: 'Prices' }).getByTestId('price-row');
  await expect(rows).toHaveCount(3);
  // The quote is now the cheapest line, so it leads.
  await expect(rows.first()).toContainText('Dynadot');
  await expect(rows.first()).toContainText('Quote');
  await expect(rows.first()).toContainText('$1.99');
  await expect(rows.first()).toContainText('$27.97');
  await expect(rows.first().getByTestId('buy-link')).toHaveAttribute('href', `https://dynadot.provider.invalid/cart?domain=${FREE}`);
  await expect(page.getByTestId('buy-cheapest')).toHaveText(/Buy at Dynadot/);
  await expect(rows.nth(1)).toContainText('Published');
});

test('a taken name offers no registration price; Watch leads and registry details expand', async ({ page }) => {
  await mockApp(page);
  await page.goto('/domains/example.com');
  await expect(page.getByTestId('domain-status')).toContainText('Taken');
  await expect(page.getByText('Fixture Registrar · expires Aug 13, 2027')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Prices' })).toHaveCount(0);
  await expect(page.getByTestId('buy-cheapest')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Watch', exact: true })).toHaveClass(/bg-primary/);

  const details = page.getByRole('region', { name: 'Registry details' });
  await expect(details.getByText('Registry expiry')).toHaveCount(0);
  await details.getByRole('button', { name: 'Registry details' }).click();
  await expect(details.getByText('Registry expiry')).toBeVisible();
  await expect(details).toContainText('Fixture Registrar');
  await expect(details).toContainText('rdap.com.fixture.invalid');
});

test('without provider keys the panel says quotes need them and links to Providers', async ({ page }) => {
  await mockApp(page);
  const keyed = PROVIDERS.map((p) => ({ ...p, capabilities: { ...p.capabilities, quote: { ...p.capabilities.quote, requiresCredentials: true } } }));
  await mockApi(page, { 'GET /providers': () => paged(keyed) });
  await page.goto(`/domains/${FREE}`);
  const prices = page.getByRole('region', { name: 'Prices' });
  await expect(prices).toContainText('Exact quotes need provider keys.');
  await expect(prices.getByRole('link', { name: 'Providers' })).toHaveAttribute('href', '/settings/providers');
  await expect(prices.getByRole('button', { name: 'Get exact quotes' })).toHaveCount(0);
});

test('an older check offers Recheck for this one name', async ({ page }) => {
  await mockApp(page);
  const old = new Date(Date.now() - 3 * 3600_000).toISOString();
  const recheck = await mockApi(page, {
    'GET /domains/:name/evidence': (_c, p) =>
      ok({
        domain: p.name,
        unicode: p.name,
        suffix: 'com',
        registry: [
          {
            id: uuid(0x7b1),
            domain: p.name,
            unicode: p.name,
            suffix: 'com',
            source: { registryId: 'verisign', protocol: 'rdap', destination: 'https://rdap.verisign.com/com/v1/', routing: 'iana_bootstrap' },
            outcome: 'no_record',
            eligibility: { status: 'unknown', source: null, scope: null },
            reason: { code: 'no_record', message: 'The registry returned no record' },
            checkedAt: old,
            staleAt: new Date(Date.now() - 2.5 * 3600_000).toISOString(),
            freshness: 'stale',
            reused: false,
            httpStatus: 404,
            retryAt: null,
            matchedName: null,
            parserVersion: 'fixture',
            registration: null,
            hasRawDiagnostics: false,
          },
        ],
        confirmations: [],
        offers: [],
        nameChecks: [],
        diagnostics: [],
        listings: [],
        collections: [],
        providers: [],
      }),
    'POST /rechecks': (c) => ({ status: 201, json: { contractVersion: '1.0.0', data: job(uuid(0x7b2), { state: 'queued', label: (c.body as { label?: string }).label ?? null }) } }),
    'GET /jobs/:id': (_c, p) => ok(job(p.id!, { state: 'running' })),
  });
  await page.goto(`/domains/${FREE}`);
  await expect(page.getByTestId('domain-status')).toContainText('checked 3 hr. ago');
  await page.getByTestId('domain-status').getByRole('button', { name: 'Recheck' }).click();
  await expect.poll(() => recheck.find((c) => c.method === 'POST' && c.path === '/rechecks')?.body).toMatchObject({ domains: [FREE] });
});

test('a job that is not a search shows its items as a plain table', async ({ page }) => {
  const id = uuid(0x801);
  const catalogItem = (providerId: string, n: number) => ({
    id: uuid(0x810 + n),
    jobId: id,
    subject: providerId,
    unicode: providerId,
    suffix: null,
    operation: 'catalog',
    target: providerId,
    source: `provider:${providerId}`,
    state: 'finished',
    attempts: 1,
    outcome: 'updated',
    resolved: true,
    error: null,
    retryAt: null,
    startedAt: NOW,
    finishedAt: NOW,
    evidence: { registry: null, confirmation: null, offers: [], nameCheck: null, diagnostic: null, listing: null },
    bestPrice: null,
    collectionIds: [],
  });
  await mockApi(page, {
    'GET /jobs/:id': () =>
      ok(job(id, { type: 'catalog_refresh', label: 'Catalog refresh', counters: { total: 2, pending: 0, running: 0, finished: 2, interrupted: 0, resolved: 2, unresolved: 0, outcomes: { updated: 2 } } })),
    'GET /jobs/:id/results': () => paged([catalogItem('porkbun', 1), catalogItem('dynadot', 2)]),
  });
  await page.goto(`/search/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Catalog refresh' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Select porkbun' })).toBeVisible();
  // Provider rows do not open a domain panel, and domain actions are not offered.
  await expect(page.getByRole('button', { name: 'porkbun', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Select porkbun' }).click();
  const toolbar = page.getByRole('toolbar', { name: 'Selected results' });
  await expect(toolbar).toContainText('1 selected');
  await expect(toolbar.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Export' })).toBeVisible();
});
