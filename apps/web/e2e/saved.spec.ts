import { expect, test } from './fixtures';
import { GIB, SMALL_SEARCH, buildJob, mockApp } from './app-fixtures';
import { label24 } from './layout-fixtures';
import { mockApi, ok, paged, uuid, startedWork } from './mock-api';

// Journey 3, "decide and buy": saved names with fresh status, cost over a few years per provider and
// the provider's own checkout link. Comparisons, prices and rechecks are fixtures.

const FREE_COM = `${GIB[0]}.com`;
const FREE_DEV = `${GIB[1]}.dev`;
const FREE_IO = `${GIB[2]}.io`;
const DOMAINS = [FREE_COM, 'example.com', FREE_DEV, FREE_IO];
const CHECKOUT = (provider: string, domain: string) => `https://${provider}.provider.invalid/checkout?domain=${domain}`;

test('Saved opens the default list and offers to recheck only the names checked a while ago', async ({ page }) => {
  const { calls } = await mockApp(page, { lists: [{ name: 'Saved', domains: DOMAINS }], staleSaved: ['example.com', FREE_DEV] });
  await page.goto('/saved');
  await expect(page.getByRole('heading', { name: 'Saved', level: 2 })).toBeVisible();
  await expect(page.getByTestId('saved-row')).toHaveCount(4);
  const taken = page.locator('[data-testid="saved-row"][data-domain="example.com"]');
  await expect(taken).toContainText('Taken');
  await expect(taken).not.toContainText('$');
  // A taken name has no registration cost to compare.
  await expect(page.getByRole('button', { name: 'Compare provider costs for example.com' })).toHaveCount(0);
  await expect(page.locator(`[data-testid="saved-row"][data-domain="${FREE_COM}"]`)).toContainText('Not registered');

  const banner = page.getByTestId('freshness-banner');
  await expect(banner).toContainText('2 names were checked over 15 minutes ago.');
  await banner.getByRole('button', { name: 'Recheck all' }).click();
  await expect.poll(() => calls.filter((c) => c.method === 'POST' && c.path === '/rechecks').length).toBe(1);
  const body = calls.find((c) => c.path === '/rechecks')?.body as { domains: string[] };
  expect(new Set(body.domains)).toEqual(new Set(['example.com', FREE_DEV]));
  await expect(page.getByText(/\bAvailable\b/)).toHaveCount(0);
});

test('Recheck all covers stale names beyond the loaded page', async ({ page }) => {
  // 230 names checked long ago; the list loads 200 at a time.
  const many = Array.from({ length: 230 }, (_, i) => `${label24(i + 900)}.com`);
  const { calls } = await mockApp(page, { lists: [{ name: 'Saved', domains: many }], staleSaved: many });
  await page.goto('/saved');
  const banner = page.getByTestId('freshness-banner');
  await expect(banner).toContainText('At least');
  await banner.getByRole('button', { name: 'Recheck all' }).click();
  await expect.poll(() => calls.filter((c) => c.method === 'POST' && c.path === '/rechecks').length).toBe(1);
  const body = calls.find((c) => c.path === '/rechecks')?.body as { domains: string[] };
  expect(new Set(body.domains)).toEqual(new Set(many));
});

test('a saved name expands into a cost comparison by provider with Buy links to that provider', async ({ page }) => {
  const { calls } = await mockApp(page, { lists: [{ name: 'Saved', domains: DOMAINS }] });
  await page.goto('/saved');
  await page.getByRole('button', { name: `Compare provider costs for ${FREE_COM}` }).click();
  const comparison = page.getByRole('table', { name: `Costs for ${FREE_COM}` });
  const rows = comparison.getByTestId('comparison-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('Porkbun');
  await expect(rows.first()).toContainText('Cheapest total');
  await expect(rows.first().getByTestId('buy-link')).toHaveAttribute('href', CHECKOUT('porkbun', FREE_COM));
  await expect(rows.nth(1).getByTestId('buy-link')).toHaveAttribute('href', CHECKOUT('dynadot', FREE_COM));
  // Totals with unknown tax say so instead of claiming a confirmed total.
  await expect(rows.nth(1)).toContainText('tax or fees unknown');
  const request = calls.find((c) => c.method === 'POST' && c.path === '/comparisons')?.body;
  expect(request).toMatchObject({ domains: [FREE_COM], purchasePath: 'new_registration' });
  // Comparisons read retained prices; nothing is sent to a provider.
  expect(calls.some((c) => c.method === 'POST' && /^\/(quotes|provider-checks)$/.test(c.path))).toBe(false);
});

test('the row Buy menu lists every provider price and links to its checkout for this name', async ({ page }) => {
  await mockApp(page, { lists: [{ name: 'Saved', domains: DOMAINS }] });
  await page.goto('/saved');
  await page.getByRole('button', { name: `Buy ${FREE_DEV}` }).click();
  const menu = page.getByRole('menu', { name: `Buy ${FREE_DEV}` });
  await expect(menu).toContainText('First year');
  await expect(menu).toContainText('3 years');
  const links = menu.getByTestId('buy-link');
  await expect(links).toHaveCount(3);
  await expect(links.first()).toHaveAttribute('href', CHECKOUT('porkbun', FREE_DEV));
  await expect(links.first()).toHaveAttribute('target', '_blank');
  await expect(links.first()).toContainText('$10.81');
  // Registrars without a published price sit in a collapsed group.
  await expect(menu.getByRole('menuitem', { name: /Other registrars/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /accredited sellers? listed by the registry/ })).toBeVisible();
});

test.describe('at a wide window', () => {
  test.use({ viewport: { width: 1680, height: 1000 } });
  test('notes are edited in place', async ({ page }) => {
    const { calls, state } = await mockApp(page, { lists: [{ name: 'Saved', domains: DOMAINS }] });
    await page.goto('/saved');
    await page.getByRole('button', { name: `Add notes for ${FREE_IO}` }).click();
    const input = page.getByRole('textbox', { name: `Notes for ${FREE_IO}` });
    await input.fill('Short, easy to say');
    await input.press('Enter');
    const listId = state.collections[0]!.id;
    await expect.poll(() => calls.find((c) => c.method === 'PATCH' && c.path === `/collections/${listId}/entries/${FREE_IO}`)?.body).toEqual({ notes: 'Short, easy to say' });
    await expect(page.getByRole('button', { name: `Edit notes for ${FREE_IO}` })).toContainText('Short, easy to say');
  });
});

test('lists are created inline and names removed from them', async ({ page }) => {
  const { calls } = await mockApp(page, { lists: [{ name: 'Saved', domains: DOMAINS }] });
  await page.goto('/saved');
  await page.getByRole('button', { name: `Remove ${FREE_IO}` }).click();
  await expect(page.locator(`[data-testid="saved-row"][data-domain="${FREE_IO}"]`)).toHaveCount(0);
  expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/entries/remove'))?.body).toEqual({ domains: [FREE_IO] });

  const nav = page.getByRole('navigation', { name: 'Saved lists' });
  await nav.getByRole('button', { name: 'New list' }).click();
  const name = nav.getByRole('textbox', { name: 'New list name' });
  await name.fill('Finalists');
  await name.press('Enter');
  await expect(page).toHaveURL(/\/saved\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Finalists', level: 2 })).toBeVisible();
  await expect(nav.getByRole('link', { name: /Finalists/ })).toHaveAttribute('aria-current', 'page');
  expect(calls.find((c) => c.method === 'POST' && c.path === '/collections')?.body).toEqual({ name: 'Finalists' });
  await expect(page.getByText('No names in this list.')).toBeVisible();
});

test('owned domains and saved searches live beside the lists', async ({ page }) => {
  const id = uuid(0xe601);
  const criteria = {
    id,
    name: 'Short names',
    filter: null,
    extensions: ['com', 'io'],
    providerIds: [],
    budget: null,
    generation: null,
    input: `example.com\n${GIB[0]}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  const { calls } = await mockApp(page, { lists: [{ name: 'Saved', domains: DOMAINS }] });
  await mockApi(page, { 'GET /criteria': () => paged([criteria]), 'GET /criteria/:id': () => ok(criteria) });
  await page.goto('/saved');
  const nav = page.getByRole('navigation', { name: 'Saved lists' });
  await nav.getByRole('link', { name: 'Domains you own' }).click();
  await expect(page).toHaveURL(/\/saved\/owned$/);
  await expect(page.getByRole('heading', { name: 'Domains you own' })).toBeVisible();
  await expect(page.getByLabel('CSV')).toBeVisible();

  await nav.getByRole('list', { name: 'Saved searches' }).getByRole('link', { name: /Short names/ }).click();
  await expect(page.getByRole('textbox', { name: 'Search names or domains' })).toHaveValue(`example.com\n${GIB[0]}`);
  await expect(page.getByTestId('restored-search')).toContainText('Short names');
  // Restoring a saved search fills the bar; it runs nothing.
  expect(startedWork(calls)).toEqual([]);
});

test('saving from results creates the Saved list on first use, by key and by button', async ({ page }) => {
  const id = uuid(0xe602);
  const { calls } = await mockApp(page, { jobs: [buildJob(id, SMALL_SEARCH, ['com', 'io', 'dev'])] });
  await page.goto(`/search/${id}`);
  const cell = page.getByRole('button', { name: new RegExp(`^${FREE_DEV.replace('.', '\\.')}:`) });
  await cell.focus();
  await page.keyboard.press('s');
  await expect(page.getByText(`Saved ${FREE_DEV}`)).toBeVisible();
  await expect.poll(() => calls.filter((c) => c.method === 'POST' && /^\/collections\/[^/]+\/entries$/.test(c.path)).length).toBe(1);
  expect(calls.filter((c) => c.method === 'POST' && c.path === '/collections').map((c) => c.body)).toEqual([{ name: 'Saved' }]);
  await expect(page.getByRole('button', { name: `Unsave ${FREE_DEV}` })).toHaveAttribute('aria-pressed', 'true');

  const other = page.locator(`[data-testid="grid-cell"][data-domain="${GIB[0]}.io"]`);
  await other.hover();
  await other.getByRole('button', { name: `Save ${GIB[0]}.io` }).click();
  await expect.poll(() => calls.filter((c) => c.method === 'POST' && /^\/collections\/[^/]+\/entries$/.test(c.path)).length).toBe(2);
  // The list exists now, so it is not created twice.
  expect(calls.filter((c) => c.method === 'POST' && c.path === '/collections')).toHaveLength(1);
  await expect(page.getByTestId('sidebar').getByRole('link', { name: /^Saved/ })).toContainText('2');
});

test('filtering a long list finds names past the first page', async ({ page }) => {
  const domains = Array.from({ length: 230 }, (_, i) => `${label24(i + 3000)}.com`);
  const target = domains[220]!;
  const { calls } = await mockApp(page, { lists: [{ name: 'Saved', domains }] });
  await page.goto('/saved');
  await expect(page.getByTestId('saved-row').first()).toBeVisible();
  // The first page holds 200 names; the match is on the second.
  await expect(page.locator(`[data-testid="saved-row"][data-domain="${target}"]`)).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Filter this list' }).fill(target.split('.')[0]!);
  const rows = page.getByTestId('saved-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-domain', target);
  expect(calls.some((c) => c.method === 'GET' && /\/entries$/.test(c.path) && c.search.get('cursor') === '200')).toBe(true);
});
