import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { W1, W2, mockMonitoring } from './page-fixtures';
import { NOW, PHONE, pageOverflow } from './mock-api';

// Route fixtures: a real watch run would query registries, so watches, runs and notices are
// simulated in memory. Providers and settings are fixtures too so the disclosure is deterministic.

test('lists watches with honest run state and opens the detail with runs and notices', async ({ page }) => {
  const calls = await mockMonitoring(page);
  await page.goto('/monitoring');
  await expect(page.getByRole('heading', { level: 1, name: 'Monitor' })).toBeVisible();
  const rows = page.getByTestId('watch-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Launch names' })).toContainText('2 missed runs');
  await expect(rows.filter({ hasText: 'Slovenian names' })).toContainText('Paused');

  await page.getByRole('link', { name: 'Launch names' }).click();
  await expect(page).toHaveURL(new RegExp(`/monitoring/${W1}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Launch names' })).toBeVisible();
  const runs = page.getByRole('region', { name: 'Runs' });
  await expect(runs.getByTestId('watch-run')).toHaveCount(3);
  await expect(runs).toContainText('Missed');
  await expect(runs).toContainText('Did not run');
  await expect(runs).toContainText('Catch-up run');
  await expect(runs).toContainText('Completed with failures');

  const notice = page.getByTestId('notice').filter({ hasText: 'example.com' });
  await expect(notice).toContainText('Registered');
  await expect(notice).toContainText('No record');
  await expect(notice).toContainText('rdap.verisign.com');
  await expect(notice.getByRole('link', { name: 'example.com' })).toHaveAttribute('href', '/domains/example.com');
  // A missing record is never presented as available.
  await expect(page.getByText('Available')).toHaveCount(0);

  // Per watch, mark all read is scoped to this watch, not every watch.
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByTestId('notice').filter({ hasText: 'Unread' })).toHaveCount(0);
  expect(calls.find((c) => c.path === '/notices/read')?.body).toEqual({ all: true, watchId: W1 });
});

test('creating a watch names every API host before saving', async ({ page }) => {
  const calls = await mockMonitoring(page);
  await page.goto('/monitoring');
  await page.getByRole('button', { name: 'New watch' }).click();
  const dialog = page.getByRole('dialog', { name: 'New watch' });
  await dialog.getByLabel('Name', { exact: true }).fill('Fixture watch');
  await dialog.getByLabel('Domains').fill('example.com\ngoogle.com\nnot a domain!');
  await expect(dialog).toContainText('Not a domain');
  await dialog.getByLabel('Domains').fill('example.com\ngoogle.com');
  await expect(dialog.getByLabel('Interval')).toContainText('Daily');
  // Catalog tracking covers chosen providers, so it waits for one.
  await expect(dialog.getByRole('switch', { name: /Published prices/ })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /Porkbun/ }).click();
  await expect(dialog.getByTestId('disclosure')).toContainText('2 domain names');
  await expect(dialog.getByTestId('disclosure')).toContainText('Porkbun (api.porkbun.com)');
  await dialog.getByRole('button', { name: 'Create watch' }).click();
  await expect(dialog).toBeHidden();
  // The interval was left at its default, so settings decide it on the backend.
  const create = calls.find((c) => c.method === 'POST' && c.path === '/watches');
  expect(create?.body).toEqual({
    name: 'Fixture watch',
    domains: ['example.com', 'google.com'],
    includeRegistry: true,
    providerIds: ['porkbun'],
    includeCatalogPrices: false,
  });
  await expect(page.getByTestId('watch-row')).toHaveCount(3);
});

test('pause, resume, run now with an idempotency key, and delete after confirming', async ({ page }) => {
  const calls = await mockMonitoring(page);
  await page.goto('/monitoring');
  const row = page.getByTestId('watch-row').filter({ hasText: 'Launch names' });
  await row.getByRole('button', { name: 'Pause Launch names' }).click();
  await expect(row).toContainText('Paused');
  await row.getByRole('button', { name: 'Resume Launch names' }).click();
  await expect(row.getByRole('button', { name: 'Pause Launch names' })).toBeVisible();

  await row.getByRole('button', { name: 'Run Launch names now' }).click();
  await expect(page.getByText('Running Launch names')).toBeVisible();
  const run = calls.find((c) => c.method === 'POST' && c.path === `/watches/${W1}/run`);
  expect(run?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);

  await row.getByRole('button', { name: 'More actions for Launch names' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete Launch names?' });
  await expect(confirm).toBeVisible();
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  await confirm.getByRole('button', { name: 'Delete watch' }).click();
  await expect(page.getByTestId('watch-row')).toHaveCount(1);
});

test('the unread filter and mark all read update the feed and the sidebar badge', async ({ page }) => {
  const calls = await mockMonitoring(page);
  await page.goto('/monitoring');
  const badge = page.getByTestId('sidebar').getByRole('link', { name: /Monitor/ });
  await expect(badge).toContainText('1');
  const feed = page.getByRole('region', { name: 'Notices' });
  await expect(feed.getByTestId('notice')).toHaveCount(2);
  // Suffix-level price notices link to price history, not a domain page.
  await expect(feed.getByRole('link', { name: '.com', exact: true })).toHaveAttribute('href', '/history?view=prices');

  await feed.getByRole('radio', { name: 'Unread' }).click();
  await expect(feed.getByTestId('notice')).toHaveCount(1);
  await feed.getByRole('button', { name: 'Mark all read' }).click();
  await expect(feed).toContainText('No unread notices.');
  expect(calls.find((c) => c.path === '/notices/read')?.body).toEqual({ all: true });
  await expect(badge).not.toContainText('1');
});

test.describe('at 375px', () => {
  test.use({ viewport: PHONE });
  test('monitoring and a watch fit without sideways scrolling', async ({ page }) => {
    await mockMonitoring(page);
    await page.goto('/monitoring');
    await expect(page.getByTestId('watch-row')).toHaveCount(2);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    await page.goto(`/monitoring/${W1}`);
    await expect(page.getByTestId('watch-run')).toHaveCount(3);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });
});

/** Serves the event stream: empty (reconnect quickly) until `deliver` holds an event. */
async function streamEvents(page: Page) {
  const pending: string[] = [];
  await page.route('**/api/v1/events**', (route) => {
    const body = pending.length ? pending.splice(0).join('') : 'retry: 100\n\n';
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  let id = 100;
  return (type: string, payload: unknown) => {
    id += 1;
    const event = { contractVersion: '1.0.0', eventId: String(id), type, occurredAt: NOW, jobId: null, watchId: null, payload };
    pending.push(`retry: 100\nid: ${id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
}

test('a watch deleted in another tab disappears from the list and closes its page', async ({ page }) => {
  await mockMonitoring(page);
  const send = await streamEvents(page);
  await page.goto('/monitoring');
  await expect(page.getByTestId('watch-row')).toHaveCount(2);
  // Another tab deletes the watch: the backend state changes, then the tombstone event arrives.
  await page.evaluate((id) => fetch(`/api/v1/watches/${id}`, { method: 'DELETE' }), W2);
  send('watch.deleted', { watchId: W2, deletedAt: NOW });
  await expect(page.getByTestId('watch-row')).toHaveCount(1);

  await page.goto(`/monitoring/${W1}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Launch names' })).toBeVisible();
  send('watch.deleted', { watchId: W1, deletedAt: NOW });
  await expect(page).toHaveURL(/\/monitoring$/);
  await expect(page.getByText('This watch was deleted')).toBeVisible();
});
