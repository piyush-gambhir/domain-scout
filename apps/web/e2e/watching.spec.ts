import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { SMALL_SEARCH, buildJob, mockApp } from './app-fixtures';
import { W1, W2, mockMonitoring } from './page-fixtures';
import { NOW, PHONE, pageOverflow, uuid } from './mock-api';

// Journey 4, "wait for a name": watch a taken name from results, then read what changed. Watches,
// runs and notices are simulated in memory; a real run would query registries.

test('w on a taken name watches it with the defaults', async ({ page }) => {
  const id = uuid(0xe701);
  const { calls } = await mockApp(page, { jobs: [buildJob(id, SMALL_SEARCH, ['com', 'io', 'dev'])] });
  await page.goto(`/search/${id}`);
  await page.getByRole('button', { name: /^example\.com:/ }).focus();
  await page.keyboard.press('w');
  await expect(page.getByText('Watching example.com')).toBeVisible();
  expect(calls.find((c) => c.method === 'POST' && c.path === '/watches')?.body).toEqual({ name: 'example.com', domains: ['example.com'] });

  // A second w does not create a duplicate.
  await expect(page.locator('[data-testid="grid-cell"][data-domain="example.com"]').getByRole('button', { name: 'Watching example.com' })).toBeAttached();
  await page.getByRole('button', { name: /^example\.com:/ }).focus();
  await page.keyboard.press('w');
  await expect(page.getByText('Already watching example.com')).toBeVisible();
  expect(calls.filter((c) => c.method === 'POST' && c.path === '/watches')).toHaveLength(1);
});

test('Watching lists watches and an inbox of changes with before and after', async ({ page }) => {
  await mockMonitoring(page);
  await page.goto('/watching');
  await expect(page.getByRole('heading', { level: 1, name: /Watching/ })).toBeVisible();
  const rows = page.getByTestId('watch-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Launch names' })).toContainText('2 missed checks');
  await expect(rows.filter({ hasText: 'Slovenian names' })).toContainText('Paused');
  // Several names show counts per state, free names first; one name shows its plain state.
  await expect(rows.filter({ hasText: 'Launch names' }).getByTestId('watch-names-state')).toHaveText('1 not registered · 1 taken');
  await expect(rows.filter({ hasText: 'Slovenian names' })).toContainText('Taken');

  const inbox = page.getByRole('region', { name: 'Changes' });
  const notice = inbox.getByTestId('notice').filter({ hasText: 'example.com' });
  await expect(notice).toContainText('Taken');
  await expect(notice).toContainText('Not registered');
  await expect(notice.getByRole('link', { name: 'example.com' })).toHaveAttribute('href', '/domains/example.com');
  // Price notices are about a whole extension and open its price history.
  await expect(inbox.getByRole('link', { name: '.com', exact: true })).toHaveAttribute('href', '/settings/prices?suffix=com');
  await expect(page.getByText(/\bAvailable\b/)).toHaveCount(0);
});

test('marking notices read updates the inbox and the sidebar badge', async ({ page }) => {
  const calls = await mockMonitoring(page);
  await page.goto('/watching');
  const badge = page.getByTestId('sidebar').getByRole('link', { name: /^Watching/ });
  await expect(badge).toContainText('1');
  const inbox = page.getByRole('region', { name: 'Changes' });
  await expect(inbox.getByTestId('notice')).toHaveCount(2);
  await inbox.getByRole('radio', { name: 'Unread' }).click();
  await expect(inbox.getByTestId('notice')).toHaveCount(1);
  await inbox.getByRole('button', { name: 'Mark example.com notice read' }).click();
  await expect(inbox).toContainText('No unread notices.');
  expect(calls.find((c) => c.path === '/notices/read')?.body).toEqual({ ids: [uuid(0xc1)] });
  await expect(badge).not.toContainText('1');
});

test('a watch shows each name with its current state, its checks and its changes', async ({ page }) => {
  const calls = await mockMonitoring(page);
  await page.goto('/watching');
  await page.getByRole('link', { name: 'Launch names' }).click();
  await expect(page).toHaveURL(new RegExp(`/watching/${W1}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Launch names' })).toBeVisible();

  const names = page.getByRole('list', { name: 'Watched names' });
  await expect(names.getByTestId('watched-name').filter({ hasText: 'example.com' })).toContainText('Not registered');
  await expect(names.getByTestId('watched-name').filter({ hasText: 'google.com' })).toContainText('Taken');

  const runs = page.getByRole('region', { name: 'Runs' });
  await expect(runs.getByTestId('watch-run')).toHaveCount(3);
  await expect(runs).toContainText('Missed');
  await expect(runs).toContainText('Did not run');
  await expect(runs).toContainText('Catch-up run');
  await expect(runs).toContainText('Completed with failures');
  await expect(runs.getByRole('link', { name: 'Results' }).first()).toHaveAttribute('href', `/search/${uuid(0xb1)}`);

  // Mark all read on a watch is scoped to that watch.
  await page.getByRole('region', { name: 'Changes' }).getByRole('button', { name: 'Mark all read' }).click();
  await expect.poll(() => calls.find((c) => c.path === '/notices/read')?.body).toEqual({ all: true, watchId: W1 });
});

test('?edit=1 opens the edit dialog, which saves interval and providers', async ({ page }) => {
  const calls = await mockMonitoring(page);
  await page.goto(`/watching/${W1}?edit=1`);
  const dialog = page.getByRole('dialog', { name: 'Edit Launch names' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Interval').click();
  await page.getByRole('option', { name: 'Weekly' }).click();
  await expect(dialog.getByTestId('disclosure')).toContainText('Porkbun (api.porkbun.com)');
  await dialog.getByRole('button', { name: 'Save watch' }).click();
  await expect(dialog).toBeHidden();
  expect(calls.find((c) => c.method === 'PATCH' && c.path === `/watches/${W1}`)?.body).toMatchObject({ intervalMinutes: 10080, providerIds: ['porkbun'] });
});

test('creating a watch names every API host before saving', async ({ page }) => {
  const calls = await mockMonitoring(page);
  await page.goto('/watching');
  await page.getByRole('button', { name: 'New watch' }).click();
  const dialog = page.getByRole('dialog', { name: 'New watch' });
  await dialog.getByLabel('Name', { exact: true }).fill('Fixture watch');
  await dialog.getByLabel('Domains').fill('example.com\ngoogle.com\nnot a domain!');
  await expect(dialog).toContainText('Not a domain');
  await dialog.getByLabel('Domains').fill('example.com\ngoogle.com');
  await expect(dialog.getByLabel('Interval')).toContainText('Daily');
  await expect(dialog.getByRole('switch', { name: /Published prices/ })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /Porkbun/ }).click();
  await expect(dialog.getByTestId('disclosure')).toContainText('2 domain names');
  await expect(dialog.getByTestId('disclosure')).toContainText('Porkbun (api.porkbun.com)');
  await dialog.getByRole('button', { name: 'Create watch' }).click();
  await expect(dialog).toBeHidden();
  expect(calls.find((c) => c.method === 'POST' && c.path === '/watches')?.body).toEqual({
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
  await page.goto('/watching');
  const row = page.getByTestId('watch-row').filter({ hasText: 'Launch names' });
  await row.getByRole('button', { name: 'Pause Launch names' }).click();
  await expect(row).toContainText('Paused');
  await row.getByRole('button', { name: 'Resume Launch names' }).click();
  await expect(row.getByRole('button', { name: 'Pause Launch names' })).toBeVisible();

  await row.getByRole('button', { name: 'Run Launch names now' }).click();
  await expect(page.getByText('Running Launch names')).toBeVisible();
  expect(calls.find((c) => c.method === 'POST' && c.path === `/watches/${W1}/run`)?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);

  await row.getByRole('button', { name: 'More actions for Launch names' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete Launch names?' });
  await expect(confirm).toBeVisible();
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  await confirm.getByRole('button', { name: 'Delete watch' }).click();
  await expect(page.getByTestId('watch-row')).toHaveCount(1);
});

/** Serves the event stream: empty (reconnect quickly) until `send` queues an event. */
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
  await page.goto('/watching');
  await expect(page.getByTestId('watch-row')).toHaveCount(2);
  await page.evaluate((id) => fetch(`/api/v1/watches/${id}`, { method: 'DELETE' }), W2);
  send('watch.deleted', { watchId: W2, deletedAt: NOW });
  await expect(page.getByTestId('watch-row')).toHaveCount(1);

  await page.goto(`/watching/${W1}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Launch names' })).toBeVisible();
  send('watch.deleted', { watchId: W1, deletedAt: NOW });
  await expect(page).toHaveURL(/\/watching$/);
  await expect(page.getByText('This watch was deleted')).toBeVisible();
});

test.describe('at 375px', () => {
  test.use({ viewport: PHONE });
  test('watching and a watch fit without sideways scrolling', async ({ page }) => {
    await mockMonitoring(page);
    await page.goto('/watching');
    await expect(page.getByTestId('watch-row')).toHaveCount(2);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    await page.goto(`/watching/${W1}`);
    await expect(page.getByTestId('watch-run')).toHaveCount(3);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });
});
