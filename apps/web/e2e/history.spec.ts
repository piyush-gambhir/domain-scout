import { readFile } from 'node:fs/promises';
import type { BrowserContext, Download, Page } from '@playwright/test';
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
  // Resuming contacts the job's destinations again; they are named before the click.
  await expect(interrupted.getByTestId('resume-destinations')).toContainText('rdap.verisign.com, rdap.arnes.si');
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
  await expect(series.filter({ hasText: 'Dynadot' })).toContainText('Renewal sale');

  await page.getByLabel('Extension').fill('si');
  await expect(page.getByText('No comparable observations')).toBeVisible();
  expect(calls.some((c) => c.path === '/price-history' && c.search.get('suffix') === 'si')).toBe(true);
});

/** Picks a format from an export menu and returns the downloaded file's name and text. */
async function exportAs(page: Page, menu: string, format: 'JSON' | 'CSV'): Promise<{ name: string; text: string }> {
  await page.getByRole('button', { name: menu }).click();
  const download: Promise<Download> = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: format }).click();
  const file = await download;
  return { name: file.suggestedFilename(), text: await readFile((await file.path())!, 'utf8') };
}

/** Exported history is built from API data only: no session or CSRF cookie values. */
async function expectNoCredentials(context: BrowserContext, text: string) {
  for (const cookie of await context.cookies()) expect(text).not.toContain(cookie.value);
  expect(text).not.toMatch(/ds_session|ds_csrf|authorization|bearer/i);
}

test('exports the shown price series as JSON and points as CSV, named by scope (H04)', async ({ page, context }) => {
  const calls = await mockPriceHistory(page);
  await page.goto('/history?view=prices');
  const settled = page.waitForResponse((r) => r.url().includes('/api/v1/price-history') && new URL(r.url()).searchParams.get('suffix') === 'com');
  await page.getByLabel('Extension').fill('.com');
  await settled;
  await expect(page.getByTestId('price-series')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Export price history' })).toBeEnabled();
  const requests = calls.length;

  const json = await exportAs(page, 'Export price history', 'JSON');
  expect(json.name).toMatch(/^domain-scout-price-history-suffix-com-\d{8}T\d{6}Z\.json$/);
  const doc = JSON.parse(json.text);
  expect(doc).toMatchObject({
    kind: 'domain-scout-price-history',
    contractVersion: '1.0.0',
    scope: { suffix: 'com', domain: null, providerId: null },
    loadedSeries: 2,
    totalSeries: 2,
    complete: true,
  });
  expect(doc.series.map((s: { key: string; points: unknown[]; gaps: unknown[] }) => [s.key, s.points.length, s.gaps.length])).toEqual([
    ['porkbun|com|new_registration|USD|-|1|0', 5, 1],
    ['dynadot|com|renewal|USD|-|1|0', 1, 0],
  ]);
  await expectNoCredentials(context, json.text);

  const csv = await exportAs(page, 'Export price history', 'CSV');
  expect(csv.name).toMatch(/^domain-scout-price-history-suffix-com-\d{8}T\d{6}Z\.csv$/);
  const lines = csv.text.trimEnd().split('\r\n');
  expect(lines[0]).toBe('seriesKey,providerId,scope,purchasePath,currency,region,termYears,promotional,offerId,observedAt,kind,registration,renewal,transfer');
  expect(lines).toHaveLength(7);
  // An unknown amount stays blank, never zero.
  expect(lines[5]).toMatch(/,2026-09-22T00:00:00\.000Z,published,,11\.08,8\.00$/);
  expect(lines[6]).toContain('dynadot|com|renewal|USD|-|1|0,dynadot,com,renewal,USD,,1,true,');
  await expectNoCredentials(context, csv.text);
  // Files come from the data on screen; exporting requested nothing.
  expect(calls.length).toBe(requests);
});

test('exports the listed jobs, named by their filter (H04)', async ({ page, context }) => {
  await mockHistory(page);
  await page.goto('/history');
  await expect(page.getByTestId('history-row')).toHaveCount(50);

  const all = await exportAs(page, 'Export job history', 'JSON');
  expect(all.name).toMatch(/^domain-scout-job-history-all-\d{8}T\d{6}Z\.json$/);
  const doc = JSON.parse(all.text);
  expect(doc).toMatchObject({ kind: 'domain-scout-job-history', contractVersion: '1.0.0', scope: { q: null, type: null }, loadedJobs: 50, totalJobs: 58, complete: false });
  expect(doc.jobs[0]).toMatchObject({ jobId: DONE, label: 'Launch scan', extensions: ['com'] });
  await expectNoCredentials(context, all.text);

  const settled = page.waitForResponse((r) => r.url().includes('/api/v1/history') && new URL(r.url()).searchParams.get('type') === 'quote');
  await page.getByRole('combobox', { name: 'Type' }).click();
  await page.getByRole('option', { name: 'Quotes' }).click();
  await settled;
  await expect(page.getByTestId('history-row')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Export job history' })).toBeEnabled();
  const quotes = await exportAs(page, 'Export job history', 'CSV');
  expect(quotes.name).toMatch(/^domain-scout-job-history-type-quote-\d{8}T\d{6}Z\.csv$/);
  const lines = quotes.text.trimEnd().split('\r\n');
  expect(lines[0]).toBe('jobId,type,label,state,createdAt,finishedAt,total,unresolved,extensions,destinations,resumable');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain(',quote,Quote request,completed,');
  await expectNoCredentials(context, quotes.text);
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
