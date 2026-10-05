import { csrfHeaders, expect, test } from './fixtures';

// Local preview only: POST /inputs/preview normalizes text without any external query, and the
// Run button is never pressed. Names are limited to the fixed live test set and invalid rows.
const INPUT = ['example.com', 'google.com', 'example.com', 'nic.si', 'bbc.co.uk', 'not a domain!'].join('\n');

test('preview shows the counts the API computes for a pasted list', async ({ page }) => {
  await page.goto('/scan');
  const probe = await page.request.post('/api/v1/inputs/preview', {
    data: { text: INPUT, format: 'auto', extensions: [] },
    headers: await csrfHeaders(page),
  });
  test.fixme(probe.status() === 404, 'POST /api/v1/inputs/preview is not implemented in the backend yet');
  expect(probe.ok()).toBe(true);
  const { data } = (await probe.json()) as {
    data: { counts: Record<'inputRows' | 'valid' | 'duplicate' | 'invalid' | 'ambiguous' | 'uniqueDomains' | 'totalChecks', number> };
  };

  await page.getByLabel('Domains or names').fill(INPUT);
  const counts = page.getByTestId('preview-counts');
  await expect(counts.getByTestId('count-rows')).toHaveText(String(data.counts.inputRows));
  await expect(counts.getByTestId('count-valid')).toHaveText(String(data.counts.valid));
  await expect(counts.getByTestId('count-duplicates')).toHaveText(String(data.counts.duplicate));
  await expect(counts.getByTestId('count-invalid')).toHaveText(String(data.counts.invalid));
  await expect(counts.getByTestId('count-ambiguous')).toHaveText(String(data.counts.ambiguous));
  await expect(counts.getByTestId('count-unique')).toHaveText(String(data.counts.uniqueDomains));
  await expect(counts.getByTestId('count-checks')).toHaveText(String(data.counts.totalChecks));

  expect(data.counts.duplicate).toBeGreaterThanOrEqual(1);
  expect(data.counts.invalid).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('preview-problems')).toContainText('not a domain!');
  await expect(page.getByRole('button', { name: /^Run \d+ checks?$/ })).toBeEnabled();
});

test('extensions accept free entry and presets', async ({ page }) => {
  await page.goto('/scan');
  const input = page.getByLabel('Add extensions');
  await input.fill('io, .co.uk  dev');
  await input.press('Enter');
  for (const ext of ['io', 'co.uk', 'dev']) await expect(page.getByRole('button', { name: `Remove .${ext}` })).toBeVisible();
  await input.fill('bad_suffix');
  await input.press('Enter');
  await expect(page.getByText('Not an extension: bad_suffix')).toBeVisible();
  await page.getByRole('button', { name: 'Remove .dev' }).click();
  await expect(page.getByRole('button', { name: 'Remove .dev' })).toHaveCount(0);
});

test('the scan draft survives navigation', async ({ page }) => {
  await page.goto('/scan');
  await page.getByLabel('Domains or names').fill('example.com');
  await page.waitForTimeout(500);
  await page.getByTestId('sidebar').getByRole('link', { name: 'Jobs' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Jobs' })).toBeVisible();
  await page.getByTestId('sidebar').getByRole('link', { name: 'Scan' }).click();
  await expect(page.getByLabel('Domains or names')).toHaveValue('example.com');
});
