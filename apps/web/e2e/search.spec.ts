import { expect, test } from './fixtures';
import { GIB, SMALL_SEARCH, buildJob, eurPriceOf, mockApp, outcomeOf, priceOf } from './app-fixtures';
import { mockApi, ok, startedWork, uuid } from './mock-api';

// Journey 1, "name a thing": a few names, one Enter, a grid of free and taken names with prices, and
// a provider checkout link two clicks away. POST /jobs is a fixture: nothing reaches a registry.

const SIX = ['com', 'io', 'dev', 'app', 'co', 'ai'];
const NOT_AVAILABLE = /\bAvailable\b/;
const FREE = `${GIB[0]}.dev`;
const CELL = (domain: string) => `[data-testid="grid-cell"][data-domain="${domain}"]`;

test('typing names and pressing Enter shows a grid of names by extension with prices', async ({ page }) => {
  const { calls } = await mockApp(page);
  await page.goto('/');
  const chips = page.getByRole('group', { name: 'Extensions' });
  for (const ext of SIX) await expect(chips.getByText(`.${ext}`, { exact: true })).toBeVisible();

  const input = page.getByRole('textbox', { name: 'Search names or domains' });
  await expect(input).toBeFocused();
  await input.fill(SMALL_SEARCH);
  // The local preview counts what Enter would check before anything runs: 3 names x 6 + 2 domains.
  await expect(page.getByTestId('search-preview')).toContainText('20 checks');
  await input.press('Enter');

  await expect(page).toHaveURL(/\/search\/[0-9a-f-]{36}$/);
  const create = calls.find((c) => c.method === 'POST' && c.path === '/jobs');
  expect(create?.body).toMatchObject({ type: 'registry_scan', input: { text: SMALL_SEARCH, extensions: SIX } });
  expect(create?.headers['x-domain-scout-client']).toBe('web');

  const grid = page.getByRole('grid', { name: 'Results by name and extension' });
  for (const name of [...GIB, 'example', 'google']) await expect(grid.getByRole('rowheader', { name })).toBeVisible();
  for (const ext of SIX) await expect(grid.getByRole('columnheader', { name: `.${ext}`, exact: true })).toBeVisible();
  // Domains typed in full keep their own extension only.
  await expect(page.locator('[data-testid="grid-cell"][data-domain^="example."]')).toHaveCount(1);

  const free = page.locator(CELL(FREE));
  await expect(free).toContainText('Not registered');
  await expect(free).toContainText(`$${priceOf(FREE)}`);
  for (const domain of ['example.com', `${GIB[1]}.io`]) {
    const taken = page.locator(CELL(domain));
    await expect(taken).toContainText('Taken');
    // A taken name is never offered at a registration price.
    await expect(taken).not.toContainText('$');
  }
  await expect(page.locator(CELL(`${GIB[2]}.ai`))).toContainText("Couldn't check");
  await expect(page.getByTestId('result-summary')).toContainText('not registered');
  await expect(page.getByText(NOT_AVAILABLE)).toHaveCount(0);

  // Two clicks from a free name to the provider's checkout page: the cell, then Buy.
  await free.getByRole('button', { name: new RegExp(`^${FREE.replace('.', '\\.')}:`) }).click();
  const dock = page.getByRole('complementary', { name: FREE });
  await expect(dock.getByTestId('domain-status')).toContainText('Not registered');
  await expect(dock.getByTestId('price-row')).toHaveCount(3);
  await expect(dock.getByTestId('buy-link').first()).toHaveAttribute('href', `https://porkbun.provider.invalid/checkout?domain=${FREE}`);
  await expect(dock.getByTestId('buy-cheapest')).toHaveAttribute('href', `https://porkbun.provider.invalid/checkout?domain=${FREE}`);
  await expect(dock.getByTestId('buy-cheapest')).toHaveAttribute('target', '_blank');
  await expect(page).toHaveURL(new RegExp(`d=${FREE.replace('.', '\\.')}`));
});

test('extension chips remove, add and apply presets, and the set is remembered in settings', async ({ page }) => {
  const { calls } = await mockApp(page);
  await page.goto('/');
  const chips = page.getByRole('group', { name: 'Extensions' });
  await expect(chips.getByText('.ai', { exact: true })).toBeVisible();
  await chips.getByRole('button', { name: 'Remove .ai', exact: true }).click();
  await expect(chips.getByText('.ai', { exact: true })).toHaveCount(0);

  await chips.getByRole('button', { name: 'Add extensions' }).click();
  await page.getByRole('textbox', { name: 'Extensions to add' }).fill('net, .co.uk');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(chips.getByText('.co.uk', { exact: true })).toBeVisible();
  await expect(chips.getByText('.net', { exact: true })).toBeVisible();

  // Quick edits are saved as one change after a short pause.
  await expect
    .poll(() => calls.filter((c) => c.method === 'PATCH' && c.path === '/settings').at(-1)?.body)
    .toEqual({ search: { defaultExtensions: ['com', 'io', 'dev', 'app', 'co', 'net', 'co.uk'] } });

  // Presets come from the backend's built-in list and replace the set.
  await chips.getByRole('button', { name: 'Presets' }).click();
  await page.getByRole('menuitem', { name: /^Tech/ }).click();
  await expect(chips.getByText('.tech', { exact: true })).toBeVisible();
  await expect(chips.getByText('.com', { exact: true })).toHaveCount(0);
  const lastSaved = () => (calls.filter((c) => c.method === 'PATCH' && c.path === '/settings').at(-1)?.body as { search?: { defaultExtensions?: string[] } } | undefined)?.search?.defaultExtensions ?? [];
  await expect.poll(lastSaved).toContain('tech');
  expect(lastSaved()).not.toContain('com');

  // A new visit starts with the remembered set.
  await page.reload();
  await expect(page.getByRole('group', { name: 'Extensions' }).getByText('.tech', { exact: true })).toBeVisible();
});

test('a CSV file reads one column, searches those names and keeps how it was read', async ({ page }) => {
  const { calls } = await mockApp(page);
  await page.goto('/');
  const csv = `notes,domain\nfirst,example.com\nsecond,${GIB[1]}.io\nthird,${GIB[0]}.dev\n`;
  await page.locator('input[type="file"]').setInputFiles({ name: 'launch-names.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const input = page.getByRole('textbox', { name: 'Search names or domains' });
  await expect(input).toHaveValue(csv);
  await expect(page.getByRole('button', { name: 'Clear launch-names.csv' })).toBeVisible();
  // Choose the column to read; the local preview counts its three domains.
  await page.getByRole('button', { name: 'Options, 1 changed' }).click();
  await expect(page.getByRole('radio', { name: 'CSV' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('textbox', { name: 'CSV column' }).fill('domain');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search-preview')).toContainText('3 checks');

  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/\/search\//);
  const create = calls.find((c) => c.method === 'POST' && c.path === '/jobs');
  // The file name labels the search in History.
  expect(create?.body).toMatchObject({ label: 'launch-names.csv', input: { text: csv, format: 'csv', csvColumn: 'domain' } });

  // One result per domain in the column, never the notes column.
  const cells = page.getByTestId('grid-cell');
  await expect(cells).toHaveCount(3);
  await expect(page.locator(CELL('example.com'))).toContainText('Taken');
  await expect(page.locator(CELL(`${GIB[1]}.io`))).toContainText('Taken');
  await expect(page.locator(CELL(`${GIB[0]}.dev`))).toContainText('Not registered');

  // The results bar restores the input the way it was read.
  await expect(page.getByRole('button', { name: 'Options, 1 changed' })).toBeVisible();
  await page.getByRole('button', { name: 'Options, 1 changed' }).click();
  await expect(page.getByRole('radio', { name: 'CSV' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('textbox', { name: 'CSV column' })).toHaveValue('domain');
});

test('ideas turn keywords into local suggestions and check only the picked names', async ({ page }) => {
  // Picked ideas are not in the fixture name set, so the fixture answers with gibberish names.
  const { calls } = await mockApp(page, { answerWith: GIB[0] });
  await page.goto('/');
  await page.getByRole('button', { name: 'Ideas' }).click();
  const keywords = page.getByRole('textbox', { name: 'Keywords' });
  await keywords.fill('scout trail');
  const ideas = page.getByRole('list', { name: 'Ideas' });
  await expect(ideas.getByRole('checkbox', { name: 'Select scouttrail' })).toBeVisible();
  // Generating ideas sends nothing to a registry.
  expect(startedWork(calls)).toEqual([]);

  await ideas.getByRole('checkbox', { name: 'Select scouttrail' }).check();
  await ideas.getByRole('checkbox', { name: 'Select trailscout' }).check();
  await expect(page.getByTestId('ideas-selection')).toContainText('2 picked');
  await page.getByRole('button', { name: 'Check 2' }).click();

  await expect(page).toHaveURL(/\/search\//);
  const create = calls.find((c) => c.method === 'POST' && c.path === '/jobs');
  expect(create?.body).toMatchObject({ input: { text: 'scouttrail\ntrailscout', format: 'lines', extensions: SIX } });
});

test('recent searches from the UI and agents open their results', async ({ page }) => {
  const id = uuid(0xe501);
  const { calls } = await mockApp(page, {
    jobs: [buildJob(id, SMALL_SEARCH, SIX, { label: 'Agent batch', origin: 'cli' }), buildJob(uuid(0xe502), GIB[0], ['com'], { label: 'Catalog', origin: 'system' })],
  });
  await page.goto('/');
  const recent = page.getByRole('region', { name: 'Recent searches' });
  await expect(recent.getByTestId('recent-search')).toHaveCount(1);
  await expect(recent).toContainText('Agent batch');
  await expect(recent).toContainText('Agent');
  await expect(recent).toContainText(/not registered of 20/);
  expect(calls.find((c) => c.path === '/history')?.search.get('origins')).toBe('ui,cli,api');
  await recent.getByTestId('recent-search').click();
  await expect(page).toHaveURL(new RegExp(`/search/${id}$`));
  await expect(page.getByTestId('grid-cell').first()).toBeVisible();
});

test('?job= restores a past search into the bar without running anything', async ({ page }) => {
  const id = uuid(0xe503);
  const { calls } = await mockApp(page, { jobs: [buildJob(id, `example.com\n${GIB[0]}`, ['com', 'io'], { label: 'Old search' })] });
  await page.goto(`/?job=${id}`);
  await expect(page.getByRole('textbox', { name: 'Search names or domains' })).toHaveValue(`example.com\n${GIB[0]}`);
  const chips = page.getByRole('group', { name: 'Extensions' });
  await expect(chips.getByText('.io', { exact: true })).toBeVisible();
  await expect(chips.getByText('.dev', { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  expect(startedWork(calls)).toEqual([]);
});

test('?criteria= restores a saved search, and its filter and budget shape the results', async ({ page }) => {
  const id = uuid(0xe504);
  const { calls } = await mockApp(page);
  await mockApi(page, {
    'GET /criteria/:id': () =>
      ok({
        id,
        name: 'Cheap dev names',
        filter: { suffixes: ['dev'], maxLength: 24 },
        extensions: ['com', 'dev'],
        providerIds: ['porkbun'],
        // A budget in another currency than the settings currency (USD) travels with the filter.
        budget: { amount: '15', currency: 'EUR' },
        generation: null,
        input: SMALL_SEARCH,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      }),
  });
  await page.goto(`/?criteria=${id}`);
  await expect(page.getByRole('textbox', { name: 'Search names or domains' })).toHaveValue(SMALL_SEARCH);
  await expect(page.getByTestId('restored-search')).toContainText('Cheap dev names');
  await expect(page.getByRole('group', { name: 'Extensions' }).getByText('.dev', { exact: true })).toBeVisible();
  expect(startedWork(calls)).toEqual([]);

  // Three names on .com and .dev plus two full domains.
  await expect(page.getByTestId('search-preview')).toContainText('8 checks');
  await page.getByRole('textbox', { name: 'Search names or domains' }).press('Enter');
  await expect(page).toHaveURL(/\/search\/[0-9a-f-]{36}\?/);

  // A restored filter opens the list view with the filter applied, not the grid.
  await expect(page.getByTestId('result-row').first()).toBeVisible();
  await expect(page.getByTestId('grid-cell')).toHaveCount(0);
  const freeQuery = () =>
    calls
      .filter((c) => c.method === 'GET' && /\/results$/.test(c.path) && c.search.get('outcomes') === 'no_record')
      .map((c) => c.search)
      .at(-1);
  await expect.poll(() => freeQuery()?.get('maxPrice')).toBe('15');
  const query = freeQuery()!;
  expect(query.get('priceCurrency')).toBe('EUR');
  expect(query.get('suffixes')).toBe('dev');
  expect(query.get('maxLength')).toBe('24');

  // Only unregistered .dev names within the EUR budget render; in USD the set would differ.
  const expected = GIB.map((g) => `${g}.dev`).filter((d) => outcomeOf(d) === 'no_record' && Number(eurPriceOf(d)) <= 15);
  const inUsd = GIB.map((g) => `${g}.dev`).filter((d) => outcomeOf(d) === 'no_record' && Number(priceOf(d)) <= 15);
  expect(expected, 'the fixture makes the currency matter').not.toEqual(inUsd);
  const rows = page.getByTestId('result-row');
  await expect(rows).toHaveCount(expected.length);
  expect(new Set(await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-domain'))))).toEqual(new Set(expected));
  await expect(page.locator('[data-testid="result-row"][data-domain="example.com"]')).toHaveCount(0);
  await expect(page).toHaveURL(/providers=porkbun/);
});
