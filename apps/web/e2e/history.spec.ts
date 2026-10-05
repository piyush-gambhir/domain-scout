import { expect, test } from './fixtures';
import { DONE, INTERRUPTED, mockHistory, mockPriceHistory } from './page-fixtures';
import { PHONE, pageOverflow, startedWork } from './mock-api';

// Job history uses fixtures: real history needs finished scans, which would query registries.
// The empty price history state uses the real backend (a fresh data directory has no prices).

test('filters by search and type and loads more pages', async ({ page }) => {
  const calls = await mockHistory(page);
  await page.goto('/history');
  await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
  const rows = page.getByTestId('history-row');
  await expect(rows).toHaveCount(50);
  await expect(page.getByText('58 jobs')).toBeVisible();
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(rows).toHaveCount(58);

  await page.getByLabel('Search history').fill('launch');
  await expect(rows).toHaveCount(1);
  expect(calls.some((c) => c.path === '/history' && c.search.get('q') === 'launch')).toBe(true);
  await page.getByLabel('Search history').fill('');
  await page.getByRole('combobox', { name: 'Type' }).click();
  await page.getByRole('option', { name: 'Quotes' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Quote request');
});

test('restoring input fills the scan form without running anything', async ({ page }) => {
  const calls = await mockHistory(page);
  await page.goto('/history');
  await page.getByRole('button', { name: 'More actions for Launch scan' }).click();
  await page.getByRole('menuitem', { name: 'Restore input' }).click();
  await expect(page).toHaveURL(/\/scan$/);
  await expect(page.getByLabel('Domains or names')).toHaveValue('example.com\nnic.si');
  await expect(page.getByRole('button', { name: 'Remove .si' })).toBeVisible();
  expect(startedWork(calls)).toEqual([]);
});

test('resumes incomplete jobs and deletes finished ones only after confirming', async ({ page }) => {
  const calls = await mockHistory(page);
  await page.goto('/history');
  const interrupted = page.getByTestId('history-row').filter({ hasText: 'Interrupted scan' });
  await expect(interrupted).toContainText('Interrupted');
  await interrupted.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText('Resumed Interrupted scan')).toBeVisible();
  expect(calls.some((c) => c.method === 'POST' && c.path === `/jobs/${INTERRUPTED}/resume`)).toBe(true);

  await page.getByRole('button', { name: 'More actions for Launch scan' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete Launch scan?' });
  await expect(dialog).toBeVisible();
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  await dialog.getByRole('button', { name: 'Delete job' }).click();
  await expect(page.getByTestId('history-row').filter({ hasText: 'Launch scan' })).toHaveCount(0);
  expect(calls.some((c) => c.method === 'DELETE' && c.path === `/jobs/${DONE}`)).toBe(true);
});

test('price history shows each comparable series with gaps left as gaps', async ({ page }) => {
  const calls = await mockPriceHistory(page);
  await page.goto('/history?view=prices');
  const series = page.getByTestId('price-series');
  await expect(series).toHaveCount(2);
  const first = series.filter({ hasText: 'Porkbun' });
  await expect(first).toContainText('New registration · USD · No region · 1 yr term · Standard');
  // Two separate line segments: the line never bridges the gap or the unknown amount.
  await expect(first.getByTestId('price-segment')).toHaveCount(2);
  await expect(first.getByTestId('price-gap')).toHaveCount(1);
  await expect(first).toContainText('No observations from');
  await expect(first.getByRole('row').filter({ hasText: 'Unknown' })).toHaveCount(1);
  await expect(series.filter({ hasText: 'Dynadot' })).toContainText('Promotional');

  await page.getByLabel('Extension').fill('si');
  await expect(page.getByText('No comparable observations')).toBeVisible();
  expect(calls.some((c) => c.path === '/price-history' && c.search.get('suffix') === 'si')).toBe(true);
});

test('price history from the real backend starts empty', async ({ page }) => {
  await page.goto('/history?view=prices');
  await page.getByLabel('Extension').fill('si');
  await expect(page.getByText('No comparable observations')).toBeVisible();
});

test.describe('at 375px', () => {
  test.use({ viewport: PHONE });
  test('history fits without sideways scrolling', async ({ page }) => {
    await mockHistory(page);
    await page.goto('/history');
    await expect(page.getByTestId('history-row').first()).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });
});
