import { expect, test } from './fixtures';
import { mockPrices } from './page-fixtures';
import { JOB_ID, domainAt, mockJobApi } from './mock-job';
import { NOW, PHONE, SETTINGS, mockApi, ok, pageOverflow } from './mock-api';

// Comparisons, transfer options and listings use fixtures so prices are known; a fresh backend has
// none. The portfolio test and the settings defaults (3 year horizon) use the real backend.

test('?domains= prefills a local comparison and marks only the cheapest complete rows', async ({ page }) => {
  const calls = await mockPrices(page);
  await page.goto('/compare?domains=example.com,google.com');
  await expect(page.getByRole('heading', { level: 1, name: 'Compare' })).toBeVisible();
  await expect(page.getByLabel('Domains')).toHaveValue('example.com\ngoogle.com');
  const example = page.getByTestId('comparison-domain').filter({ has: page.getByRole('heading', { name: 'example.com' }) });
  await expect(example.getByTestId('comparison-row')).toHaveCount(3);
  // Confirmed totals and base subtotals come from separate API lists and are labeled apart.
  await expect(example.getByText('Cheapest total in USD')).toHaveCount(1);
  await expect(example.getByTestId('comparison-row').filter({ hasText: 'Porkbun' })).toContainText('Cheapest total');
  const dynadot = example.getByTestId('comparison-row').filter({ hasText: 'Dynadot' });
  await expect(dynadot).toContainText('Lowest subtotal in USD, tax or fees unknown');
  await expect(dynadot).toContainText('Subtotal only, tax or fees unknown');
  await expect(dynadot).toContainText('by subtotal');
  await expect(dynadot).not.toContainText('Cheapest');
  const hostinger = example.getByTestId('comparison-row').filter({ hasText: 'Hostinger' });
  await expect(hostinger).toContainText('Unknown');
  await expect(hostinger).toContainText('Not ranked');
  await expect(hostinger).not.toContainText('$0');
  await expect(example).toContainText('No price is known from this provider for this purchase path: Hostinger');
  await expect(dynadot.getByRole('link', { name: /Open/ })).toHaveAttribute('href', /dynadot\.provider\.invalid/);

  const request = calls.find((c) => c.method === 'POST' && c.path === '/comparisons');
  // Horizon and currency are left to backend settings unless changed here.
  expect(request?.body).toEqual({ domains: ['example.com', 'google.com'], purchasePath: 'new_registration' });
  // Comparing the same request again reloads it, so newly retained prices show up.
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect.poll(() => calls.filter((c) => c.method === 'POST' && c.path === '/comparisons').length).toBe(2);
});

test('the transfer tab compares transfer costs and lists eligibility read-only', async ({ page }) => {
  const calls = await mockPrices(page);
  await page.goto('/compare?domains=example.com');
  await page.getByRole('tab', { name: 'Transfer' }).click();
  await expect(page).toHaveURL(/tab=transfer/);
  const options = page.getByTestId('transfer-options');
  await expect(options).toContainText('clientTransferProhibited');
  await expect(options).toContainText('Registration age at least 60 days');
  await expect(options).toContainText('Includes 1 year');
  await expect(options).toContainText('Stale');
  // Read-only: there is no field for an authorization code.
  await expect(page.getByLabel(/auth/i)).toHaveCount(0);
  expect(calls.filter((c) => c.method === 'POST' && c.path === '/comparisons').map((c) => (c.body as { purchasePath: string }).purchasePath)).toContain('transfer');
});

test('aftermarket separates supported and link-only sources and discloses before a lookup', async ({ page }) => {
  const calls = await mockPrices(page);
  await page.goto('/compare?tab=aftermarket&domains=example.com');
  const listing = page.getByTestId('listing');
  await expect(listing).toContainText('Fixed price');
  await expect(listing).toContainText('$2,500.00');
  await expect(listing).toContainText('A listing is not proof of seller authority or final cost.');
  await expect(page.getByRole('link', { name: /Afternic/ })).toHaveAttribute('href', 'https://afternic.marketplace.invalid/search?q=example.com');

  await expect(page.getByRole('button', { name: 'Look up listings' })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Sedo' }).click();
  await expect(page.getByTestId('disclosure')).toContainText('Sends 1 domain name to Sedo (api.sedo.com)');
  await page.getByRole('button', { name: 'Look up listings' }).click();
  await expect(page.getByText('Listing lookup started')).toBeVisible();
  const lookup = calls.find((c) => c.method === 'POST' && c.path === '/aftermarket');
  expect(lookup?.body).toEqual({ domains: ['example.com'], sources: ['sedo'] });
  expect(lookup?.headers['idempotency-key']).toBeTruthy();
});

test('portfolio import reports rejected rows and keeps your entries apart from observed prices', async ({ page }) => {
  // Real backend: import, list, comparison and delete are local.
  await page.goto('/compare?tab=portfolio');
  await page.getByLabel('CSV').fill(
    ['domain,registrar,renewalDate,renewalPrice,currency,notes', 'bbc.co.uk,Fixture Registrar,2027-01-01,12.00,USD,main', 'not a domain,,,,,'].join('\n'),
  );
  await page.getByRole('button', { name: 'Import' }).click();
  const result = page.getByTestId('import-result');
  await expect(result).toContainText('1 row rejected');
  await expect(result.getByRole('row').filter({ hasText: 'not a domain' })).toBeVisible();

  const entry = page.getByTestId('portfolio-entry').filter({ hasText: 'bbc.co.uk' });
  await expect(entry).toContainText('Fixture Registrar');
  await expect(entry).toContainText('$12.00');
  const comparison = page.getByTestId('portfolio-comparison').filter({ hasText: 'bbc.co.uk' });
  await expect(comparison).toContainText('You entered');
  await expect(comparison).toContainText('Observed prices');

  await entry.getByRole('button', { name: 'Delete bbc.co.uk' }).click();
  await page.getByRole('alertdialog', { name: 'Delete bbc.co.uk?' }).getByRole('button', { name: 'Delete entry' }).click();
  await expect(page.getByTestId('portfolio-entry').filter({ hasText: 'bbc.co.uk' })).toHaveCount(0);
});

test('selected job results open a comparison', async ({ page }) => {
  await mockJobApi(page);
  await page.goto(`/jobs/${JOB_ID}`);
  await page.getByRole('checkbox', { name: `Select ${domainAt(0)}` }).click();
  await page.getByRole('checkbox', { name: `Select ${domainAt(1)}` }).click();
  await page.getByRole('button', { name: 'More actions for selected results' }).click();
  await page.getByRole('menuitem', { name: 'Compare prices' }).click();
  await expect(page).toHaveURL(/\/compare\?domains=/);
  await expect(page.getByLabel('Domains')).toHaveValue(`${domainAt(0)}\n${domainAt(1)}`);
});

test.describe('at 375px', () => {
  test.use({ viewport: PHONE });
  test('compare fits without sideways scrolling', async ({ page }) => {
    await mockPrices(page);
    await page.goto('/compare?domains=example.com,google.com');
    await expect(page.getByTestId('comparison-row').first()).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    await page.getByRole('tab', { name: 'Aftermarket' }).click();
    await expect(page.getByTestId('listing')).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });
});

test('original currencies is an explicit choice when settings convert by default', async ({ page }) => {
  const calls = await mockPrices(page);
  await mockApi(page, {
    'GET /settings': () =>
      ok({
        ...SETTINGS,
        comparison: { horizonYears: 3, currency: 'EUR' },
        fxRates: [{ from: 'USD', to: 'EUR', rate: '0.92', source: 'ECB reference rate', observedAt: NOW }],
      }),
  });
  await page.goto('/compare?domains=example.com');
  const comparisons = () => calls.filter((c) => c.method === 'POST' && c.path === '/comparisons').map((c) => c.body);
  // Untouched, the request leaves the currency to settings.
  await expect.poll(() => comparisons().length).toBe(1);
  expect(comparisons()[0]).not.toHaveProperty('currency');
  await page.getByRole('combobox', { name: 'Currency' }).click();
  await expect(page.getByRole('option', { name: 'Default, EUR' })).toBeVisible();
  await page.getByRole('option', { name: 'Original currencies' }).click();
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect.poll(() => comparisons().length).toBe(2);
  expect(comparisons()[1]).toMatchObject({ currency: null });
  await page.getByRole('combobox', { name: 'Currency' }).click();
  await page.getByRole('option', { name: 'USD' }).click();
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect.poll(() => comparisons().length).toBe(3);
  expect(comparisons()[2]).toMatchObject({ currency: 'USD' });
});
