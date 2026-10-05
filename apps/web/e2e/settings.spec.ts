import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { mockSettings } from './page-fixtures';
import { EARLIER, NOW, PHONE, SETTINGS, mockApi, ok, pageOverflow, paged, uuid } from './mock-api';

// Settings writes go to an in-memory fixture: the real backend is shared by parallel specs, and a
// saved theme or concurrency change would leak into them. Coverage, health and capabilities are
// read from the real backend. Coverage refresh (IANA), data deletion and service stop are fixtures.

test('appearance switches the theme and saves it to settings', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const calls = await mockSettings(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect.poll(() => calls.find((c) => c.method === 'PATCH')?.body).toEqual({ appearance: { theme: 'dark' } });
});

test('a fresh browser takes the saved theme from settings', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await mockApi(page, { 'GET /settings': () => ok({ ...SETTINGS, appearance: { theme: 'dark' } }) });
  await page.goto('/scan');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
});

test('checks validate ranges and save only what changed', async ({ page }) => {
  const calls = await mockSettings(page);
  await page.goto('/settings?section=checks');
  const save = page.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();
  await page.getByLabel('Checks in flight').fill('99');
  await expect(page.getByText('Whole number, 1 to 64')).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByLabel('Checks in flight').fill('8');
  await page.getByRole('radio', { name: 'Cloudflare' }).click();
  await save.click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ concurrency: { global: 8 }, diagnostics: { resolver: 'cloudflare' } });
});

test('exchange rates need a source and an observed time', async ({ page }) => {
  const calls = await mockSettings(page);
  await page.goto('/settings?section=pricing');
  await page.getByRole('button', { name: 'Add rate' }).click();
  const rate = page.getByTestId('fx-rate');
  await rate.getByLabel('From', { exact: true }).fill('usd');
  await rate.getByLabel('To', { exact: true }).fill('EUR');
  await rate.getByLabel('Rate', { exact: true }).fill('0.92');
  await expect(rate).toContainText('Source is required');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await rate.getByLabel('Source', { exact: true }).fill('ECB reference rate');
  await rate.getByLabel('Observed', { exact: true }).fill('2026-10-05T09:30');
  await page.getByLabel('Comparison currency').fill('eur');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Pricing saved')).toBeVisible();
  const body = calls.find((c) => c.method === 'PATCH')?.body as { comparison: unknown; fxRates: { observedAt: string }[] };
  expect(body.comparison).toEqual({ horizonYears: 3, currency: 'EUR' });
  expect(body.fxRates).toEqual([{ from: 'USD', to: 'EUR', rate: '0.92', source: 'ECB reference rate', observedAt: new Date('2026-10-05T09:30').toISOString() }]);
});

test('saving pricing leaves untouched exchange rates exactly as saved', async ({ page }) => {
  const rate = { from: 'USD', to: 'EUR', rate: '0.92', source: 'ECB reference rate', observedAt: '2026-10-05T09:30:45.123Z' };
  let settings: Record<string, unknown> = { ...SETTINGS, fxRates: [rate] };
  const calls = await mockApi(page, {
    'GET /settings': () => ok(settings),
    'PATCH /settings': (c) => {
      settings = { ...settings, ...(c.body as object) };
      return ok(settings);
    },
  });
  await page.goto('/settings?section=pricing');
  await expect(page.getByTestId('fx-rate')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Ownership horizon' }).click();
  await page.getByRole('option', { name: '5 years' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Pricing saved')).toBeVisible();
  expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ comparison: { horizonYears: 5, currency: null } });
});

test('coverage shows its limits and filters by status', async ({ page }) => {
  const calls = await mockApi(page, {
    'POST /coverage/refresh': () =>
      ok({ bootstrapPublishedAt: NOW, bootstrapFetchedAt: NOW, counts: { tested: 10, discovered: 1197, unsupported: 231 }, limits: ['Fixture limit.'] }),
  });
  await page.goto('/settings?section=coverage');
  const counts = page.getByTestId('coverage-counts');
  await expect(counts).toContainText('Tested');
  await expect(page.getByRole('list', { name: 'Coverage limits' })).toContainText('does not show that the endpoint answers');
  await expect(page.getByTestId('coverage-row').first()).toBeVisible();
  await page.getByRole('radio', { name: 'Tested' }).click();
  await expect.poll(() => calls.some((c) => c.path === '/coverage' && c.search.get('status') === 'tested')).toBe(true);
  await page.getByLabel('Search extensions').fill('.si');
  await expect(page.getByTestId('coverage-row').filter({ hasText: '.si' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Refresh from IANA' }).click();
  await expect(page.getByRole('list', { name: 'Coverage limits' })).toContainText('Fixture limit.');
});

test('data deletion states exactly what will be removed before deleting', async ({ page }) => {
  const shortlist = uuid(0x601);
  const calls = await mockApi(page, {
    'GET /data': () =>
      ok({
        dataDir: '/tmp/domain-scout-fixture',
        databaseBytes: 3_145_728,
        categories: [
          { category: 'jobs', count: 12 },
          { category: 'price_history', count: 40 },
          { category: 'collections', count: 2 },
        ],
      }),
    'GET /collections': () =>
      paged([
        { id: shortlist, name: 'Launch names', notes: null, entryCount: 3, createdAt: EARLIER, updatedAt: EARLIER },
        { id: uuid(0x602), name: 'Keep these', notes: null, entryCount: 5, createdAt: EARLIER, updatedAt: EARLIER },
      ]),
    'POST /data/delete': () => ok({ deleted: [{ category: 'jobs', count: 7 }, { category: 'collections', count: 1 }] }),
  });
  await page.goto('/settings?section=data');
  await expect(page.getByText('/tmp/domain-scout-fixture')).toBeVisible();
  await expect(page.getByText('3.0 MB')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Jobs and results' }).click();
  await page.getByRole('checkbox', { name: 'Shortlists' }).click();
  await page.getByRole('checkbox', { name: 'Launch names' }).click();
  await page.getByLabel('Only records from before').fill('2026-10-01');
  await page.getByRole('button', { name: 'Delete selected data' }).click();

  const dialog = page.getByRole('alertdialog', { name: 'Delete local data?' });
  await expect(dialog).toContainText('Only records from before Oct 1, 2026');
  const summary = dialog.getByTestId('delete-summary');
  await expect(summary).toContainText('Jobs and results');
  await expect(summary).toContainText('up to 12');
  await expect(summary).toContainText('Shortlists: Launch names');
  await expect(summary).not.toContainText('Keep these');
  await expect(summary).not.toContainText('Prices');
  expect(calls.some((c) => c.path === '/data/delete')).toBe(false);

  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Deleted 8 records')).toBeVisible();
  expect(calls.find((c) => c.path === '/data/delete')?.body).toEqual({
    categories: ['jobs', 'collections'],
    collectionIds: [shortlist],
    before: new Date('2026-10-01T00:00:00').toISOString(),
  });
});

test('exports and snapshots download through the forwarder and delete after confirming', async ({ page }) => {
  const exportId = uuid(0x701);
  const snapshotId = uuid(0x702);
  let exports = [
    {
      id: exportId,
      format: 'csv',
      scope: { kind: 'collection', collectionId: uuid(0x601) },
      fields: ['domain'],
      itemCount: 3,
      fileName: 'launch-names.csv',
      sizeBytes: 2048,
      createdAt: NOW,
      downloadPath: `/exports/${exportId}/download`,
      warnings: [],
    },
  ];
  const calls = await mockApi(page, {
    'GET /exports': () => paged(exports),
    'DELETE /exports/:id': (_c, p) => {
      exports = exports.filter((e) => e.id !== p.id);
      return ok({ ok: true });
    },
    'GET /snapshots': () =>
      paged([
        {
          id: snapshotId,
          title: 'Launch snapshot',
          scope: { kind: 'domains', domains: ['example.com'] },
          include: { evidence: true, prices: true, registration: false, notes: false },
          itemCount: 1,
          createdAt: NOW,
          htmlPath: '/tmp/snap.html',
          jsonPath: '/tmp/snap.json',
          sizeBytes: 9000,
        },
      ]),
  });
  await page.goto('/settings?section=artifacts');
  const row = page.getByTestId('export-row');
  await expect(row).toContainText('launch-names.csv');
  await expect(row).toContainText('Shortlist');
  await expect(row.getByRole('link', { name: 'Download launch-names.csv' })).toHaveAttribute('href', `/api/v1/exports/${exportId}/download`);
  const snapshot = page.getByTestId('snapshot-row');
  await expect(snapshot).toContainText('evidence, prices');
  await expect(snapshot.getByRole('link', { name: 'Download Launch snapshot as HTML' })).toHaveAttribute('href', `/api/v1/snapshots/${snapshotId}/download?format=html`);
  await expect(snapshot.getByRole('link', { name: 'Download Launch snapshot as JSON' })).toHaveAttribute('href', `/api/v1/snapshots/${snapshotId}/download?format=json`);

  await row.getByRole('button', { name: 'Delete launch-names.csv' }).click();
  await page.getByRole('alertdialog', { name: 'Delete launch-names.csv?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('No exports.')).toBeVisible();
  expect(calls.some((c) => c.method === 'DELETE' && c.path === `/exports/${exportId}`)).toBe(true);
});

test('service shows versions from the backend and stops only after confirming', async ({ page }) => {
  const calls = await mockApi(page, { 'POST /service/stop': () => ({ status: 202, json: { contractVersion: '1.0.0', data: { stopping: true, graceMs: 5000 } } }) });
  await page.goto('/settings?section=service');
  const backend = page.getByRole('region', { name: 'Service' });
  await expect(backend).toContainText('1.0.0');
  await expect(backend).toContainText('MCP adapter');
  await page.getByRole('button', { name: 'Stop backend' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Stop the local backend?' });
  await expect(dialog).toBeVisible();
  expect(calls.some((c) => c.path === '/service/stop')).toBe(false);
  await dialog.getByRole('button', { name: 'Stop backend' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Stopping.' })).toBeVisible();
  expect(calls.filter((c) => c.path === '/service/stop')).toHaveLength(1);
});

test.describe('at 375px', () => {
  test.use({ viewport: PHONE });
  test('settings sections fit without sideways scrolling', async ({ page }) => {
    await mockSettings(page);
    // Wait for each section's loaded content, not its heading, before measuring.
    const loaded: Record<string, (p: Page) => ReturnType<Page['getByText']>> = {
      checks: (p) => p.getByLabel('Checks in flight'),
      pricing: (p) => p.getByLabel('Ownership horizon'),
      coverage: (p) => p.getByTestId('coverage-row').first(),
      data: (p) => p.getByRole('button', { name: 'Delete selected data' }),
      // Health and capabilities load separately; the protocol fact appears only with health data.
      service: (p) => p.getByRole('region', { name: 'Service' }).getByText('Protocol', { exact: true }),
    };
    for (const [section, locate] of Object.entries(loaded)) {
      await page.goto(`/settings?section=${section}`);
      await expect(locate(page)).toBeVisible();
      if (section === 'service') await expect(page.getByText('MCP adapter')).toBeVisible();
      expect(await pageOverflow(page), section).toBeLessThanOrEqual(0);
    }
  });
});
