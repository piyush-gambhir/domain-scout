import { csrfHeaders, expect, test } from './fixtures';
import { PHONE, mockApi, pageOverflow, startedWork } from './mock-api';

// Real backend: generation and saved criteria are local. Nothing here starts a scan; the test
// records every API call and asserts that no job or external operation was requested.

const ROOTS = ['example', 'google', 'bad_root!'];

async function fillRoots(page: import('@playwright/test').Page) {
  await page.getByLabel('Roots').fill(ROOTS.join('\n'));
  // Roots only, so candidates are exactly the supplied labels.
  await page.getByRole('button', { name: 'Prefixes and suffixes' }).click();
  await page.getByRole('button', { name: 'Compounds' }).click();
  await page.getByLabel('Maximum length').fill('30');
  const extensions = page.getByLabel('Add extensions');
  await extensions.fill('com');
  await extensions.press('Enter');
}

test('generates locally, edits the list and sends a selection to scan without running anything', async ({ page }) => {
  const calls = await mockApi(page, {});
  await page.goto('/discover');
  await expect(page.getByRole('heading', { level: 1, name: 'Discover' })).toBeVisible();
  await fillRoots(page);

  const list = page.getByRole('list', { name: 'Candidate list' });
  await expect(list.getByText('google', { exact: true })).toBeVisible();
  // Counts are the API's own numbers for the same request.
  const probe = await page.request.post('/api/v1/generation/preview', {
    data: { roots: ROOTS, strategies: ['roots'], extensions: ['com'], rules: { minLength: 3, maxLength: 30, allowDigits: false, allowHyphens: false, exclude: [] }, limit: 300 },
    headers: await csrfHeaders(page),
  });
  expect(probe.ok()).toBe(true);
  const { data } = (await probe.json()) as { data: { counts: Record<string, number>; expandedChecks: number } };
  const counts = page.getByTestId('generation-counts');
  await expect(counts.getByTestId('count-unique')).toHaveText(String(data.counts.unique));
  await expect(counts.getByTestId('count-invalid')).toHaveText(String(data.counts.invalid));
  await expect(counts.getByTestId('count-expanded')).toHaveText(String(data.expandedChecks));

  // The invalid root is listed with its issue and cannot be selected.
  await expect(page.getByRole('checkbox', { name: 'Select bad_root!' })).toBeDisabled();
  await expect(list).toContainText('invalid characters');

  // Edit: remove one, add a complete domain of your own, deselect nothing else.
  await page.getByRole('button', { name: 'Remove google' }).click();
  await expect(list.getByText('google', { exact: true })).toHaveCount(0);
  await page.getByLabel('Add names').fill('nic.si');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(list.getByText('nic.si', { exact: true })).toBeVisible();
  await expect(page.getByTestId('selection-summary')).toContainText('2 selected');
  await expect(page.getByTestId('selection-summary')).toContainText('2 checks');

  await page.getByRole('button', { name: 'Send 2 to scan' }).click();
  await expect(page).toHaveURL(/\/scan$/);
  await expect(page.getByLabel('Domains or names')).toHaveValue('nic.si\nexample');
  await expect(page.getByRole('button', { name: 'Remove .com' })).toBeVisible();
  expect(startedWork(calls)).toEqual([]);
});

test('saves criteria and restores them from ?criteria= without running anything', async ({ page, browser }) => {
  await page.goto('/discover');
  await fillRoots(page);
  await expect(page.getByRole('list', { name: 'Candidate list' }).getByText('google', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select google' }).click();
  await expect(page.getByTestId('selection-summary')).toContainText('1 selected');

  const name = `Discover ${Date.now()}`;
  await page.getByRole('button', { name: 'Save criteria' }).click();
  await page.getByLabel('Criteria name').fill(name);
  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/criteria') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const { data } = (await response.json()) as { data: { id: string; generation: { roots: string[] }; extensions: string[]; input: string } };
  expect(data.generation.roots).toEqual(ROOTS);
  expect(data.extensions).toEqual(['com']);
  expect(data.input).toBe('example');

  // A fresh browser session (no draft) restores the rules and the edited selection.
  const context = await browser.newContext({ storageState: process.env.DS_E2E_STORAGE, baseURL: process.env.DS_E2E_WEB_URL });
  const fresh = await context.newPage();
  const calls = await mockApi(fresh, {});
  await fresh.goto(`/discover?criteria=${data.id}`);
  await expect(fresh.getByLabel('Roots')).toHaveValue(ROOTS.join('\n'));
  await expect(fresh.getByRole('button', { name: 'Remove .com' })).toBeVisible();
  await expect(fresh.getByTestId('selection-summary')).toContainText('1 selected');
  await expect(fresh.getByRole('checkbox', { name: 'Select google' })).not.toBeChecked();
  await expect(fresh).toHaveURL(/\/discover$/);
  expect(startedWork(calls)).toEqual([]);
  await context.close();
});

test.describe('at 375px', () => {
  test.use({ viewport: PHONE });
  test('discover fits without sideways scrolling', async ({ page }) => {
    await page.goto('/discover');
    await fillRoots(page);
    await expect(page.getByRole('list', { name: 'Candidate list' }).getByText('google', { exact: true })).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });
});
