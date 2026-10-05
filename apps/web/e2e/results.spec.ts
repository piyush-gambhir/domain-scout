import { expect, test } from './fixtures';
import { JOB_ID, TOTAL, domainAt, mockJobApi } from './mock-job';
import { NOW, job, mockApi, ok, paged, uuid } from './mock-api';

// Uses intercepted API fixtures (reserved .test names), so it exercises the UI without any scan.

test('virtualized results load pages on scroll and keep the DOM small', async ({ page }) => {
  const queries = await mockJobApi(page);
  await page.goto(`/jobs/${JOB_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Fixture scan' })).toBeVisible();
  await expect(page.getByText(`${TOTAL.toLocaleString('en')} results`)).toBeVisible();
  await expect(page.getByRole('button', { name: domainAt(0), exact: true })).toBeVisible();

  const rendered = await page.locator('[role="row"][data-row-index]').count();
  expect(rendered).toBeGreaterThan(5);
  expect(rendered).toBeLessThan(80);

  for (let i = 0; i < 40 && !(await page.getByRole('button', { name: domainAt(TOTAL - 1), exact: true }).isVisible()); i++) {
    await page.mouse.wheel(0, 6000);
    await page.waitForTimeout(120);
  }
  await expect(page.getByRole('button', { name: domainAt(TOTAL - 1), exact: true })).toBeVisible();
  expect(queries.filter((q) => q.includes('cursor=')).length).toBeGreaterThanOrEqual(6);
  expect(await page.locator('[role="row"][data-row-index]').count()).toBeLessThan(80);
});

test('selection supports shift ranges and select all matching', async ({ page }) => {
  await mockJobApi(page);
  await page.goto(`/jobs/${JOB_ID}`);
  await page.getByRole('checkbox', { name: `Select ${domainAt(0)}` }).click();
  await page.getByRole('checkbox', { name: `Select ${domainAt(4)}` }).click({ modifiers: ['Shift'] });
  const toolbar = page.getByRole('toolbar', { name: 'Selected results' });
  await expect(toolbar).toContainText('5 selected');
  await toolbar.getByRole('button', { name: 'Clear selection' }).click();
  await expect(toolbar).toBeHidden();

  await page.getByRole('checkbox', { name: 'Select loaded rows' }).click();
  await expect(toolbar).toContainText('200 selected');
  await page.getByRole('button', { name: `Select all ${TOTAL.toLocaleString('en')} matching` }).click();
  await expect(toolbar).toContainText(`${TOTAL.toLocaleString('en')} selected`);
});

test('outcome filters update the URL and the backend query', async ({ page }) => {
  const queries = await mockJobApi(page);
  await page.goto(`/jobs/${JOB_ID}`);
  await page.getByRole('group', { name: 'Filter by outcome' }).getByRole('button', { name: /No record/ }).click();
  await expect(page).toHaveURL(/outcomes=no_record/);
  await expect(page.getByText('250 results')).toBeVisible();
  expect(queries.some((q) => q.includes('outcomes=no_record'))).toBe(true);
  // Unresolved outcomes are labeled as such and never as available.
  await expect(page.getByText('Available')).toHaveCount(0);
});

test('the confirmation filter is sent to the backend and kept in the URL (S01)', async ({ page }) => {
  const queries = await mockJobApi(page);
  await page.goto(`/jobs/${JOB_ID}`);
  await expect(page.getByText(`${TOTAL.toLocaleString('en')} results`)).toBeVisible();
  await page.getByRole('button', { name: 'Confirmation', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Available', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Restricted', exact: true }).click();
  await expect(page).toHaveURL(/confirmations=available%2Crestricted|confirmations=available,restricted/);
  await expect.poll(() => queries.some((q) => new URLSearchParams(q).get('confirmations') === 'available,restricted')).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Confirmation/ })).toContainText('2');
});

test('rechecking selected rows submits only the selected domains (S03)', async ({ page }) => {
  await mockJobApi(page);
  const calls = await mockApi(page, {
    'POST /rechecks': (c) => ({
      status: 201,
      json: {
        contractVersion: '1.0.0',
        data: job(uuid(0x701), { type: 'registry_scan', state: 'queued', counters: { total: (c.body as { domains: string[] }).domains.length, pending: 0, running: 0, finished: 0, interrupted: 0, resolved: 0, unresolved: 0, outcomes: {} } }),
      },
    }),
  });
  const rechecks = () => calls.filter((c) => c.method === 'POST' && c.path === '/rechecks').map((c) => (c.body as { domains: string[] }).domains);
  await page.goto(`/jobs/${JOB_ID}`);
  const toolbar = page.getByRole('toolbar', { name: 'Selected results' });

  // Two explicit rows.
  await page.getByRole('checkbox', { name: `Select ${domainAt(3)}` }).click();
  await page.getByRole('checkbox', { name: `Select ${domainAt(0)}` }).click();
  await expect(toolbar).toContainText('2 selected');
  await toolbar.getByRole('button', { name: 'Recheck' }).click();
  await expect(page.getByText('Recheck of 2 domains started')).toBeVisible();
  expect(rechecks()).toEqual([[domainAt(3), domainAt(0)]]);

  // Every row matching a filter, past the loaded page, and nothing outside it.
  await toolbar.getByRole('button', { name: 'Clear selection' }).click();
  await page.getByRole('group', { name: 'Filter by outcome' }).getByRole('button', { name: /No record/ }).click();
  await expect(page.getByText('250 results')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select loaded rows' }).click();
  await page.getByRole('button', { name: 'Select all 250 matching' }).click();
  await expect(toolbar).toContainText('250 selected');
  await toolbar.getByRole('button', { name: 'Recheck' }).click();
  await expect(page.getByText('Recheck of 250 domains started')).toBeVisible();
  const noRecord = Array.from({ length: TOTAL }, (_, i) => i).filter((i) => i % 6 === 1).map(domainAt);
  expect(rechecks()[1]).toEqual(noRecord);
});

test('a row opens the detail panel beside the table', async ({ page }) => {
  await mockJobApi(page);
  await page.goto(`/jobs/${JOB_ID}`);
  await page.getByRole('button', { name: domainAt(1), exact: true }).click();
  const panel = page.getByRole('dialog', { name: domainAt(1) });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Registry' })).toContainText('No record');
  await expect(page).toHaveURL(new RegExp(`d=${domainAt(1).replace('.', '\\.')}`));
  // The table stays usable: another row swaps the panel content.
  await page.getByRole('button', { name: domainAt(0), exact: true }).click();
  await expect(page.getByRole('dialog', { name: domainAt(0) })).toContainText('Registered');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('changing the filter clears the selection', async ({ page }) => {
  await mockJobApi(page);
  await page.goto(`/jobs/${JOB_ID}`);
  await page.getByRole('checkbox', { name: 'Select loaded rows' }).click();
  await page.getByRole('button', { name: `Select all ${TOTAL.toLocaleString('en')} matching` }).click();
  const toolbar = page.getByRole('toolbar', { name: 'Selected results' });
  await expect(toolbar).toContainText(`${TOTAL.toLocaleString('en')} selected`);
  await page.getByRole('group', { name: 'Filter by outcome' }).getByRole('button', { name: /No record/ }).click();
  await expect(page.getByText('250 results')).toBeVisible();
  await expect(toolbar).toBeHidden();
  // Returning to the previous filter does not bring the old selection back.
  await page.getByRole('group', { name: 'Filter by outcome' }).getByRole('button', { name: /No record/ }).click();
  await expect(page.getByText(`${TOTAL.toLocaleString('en')} results`)).toBeVisible();
  await expect(toolbar).toBeHidden();
});

test('closing a dialog returns focus to the control that opened it', async ({ page }) => {
  await mockJobApi(page);
  await page.goto(`/jobs/${JOB_ID}`);
  await page.getByRole('checkbox', { name: `Select ${domainAt(0)}` }).click();
  const exportButton = page.getByRole('toolbar', { name: 'Selected results' }).getByRole('button', { name: 'Export' });
  await exportButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeHidden();
  await expect(exportButton).toBeFocused();
});

test('a dialog opened from a menu returns focus to the menu trigger', async ({ page }) => {
  await mockJobApi(page);
  await page.goto(`/jobs/${JOB_ID}`);
  const more = page.getByRole('button', { name: 'More job actions' });
  await more.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Snapshot' }).click();
  await expect(page.getByRole('dialog', { name: 'Snapshot' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Snapshot' })).toBeHidden();
  await expect(more).toBeFocused();
});

test('TXT exports keep candidates by default and include every name only when asked', async ({ page }) => {
  await mockJobApi(page);
  await page.goto(`/jobs/${JOB_ID}`);
  await page.getByRole('checkbox', { name: `Select ${domainAt(0)}` }).click();
  await page.getByRole('toolbar', { name: 'Selected results' }).getByRole('button', { name: 'Export' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: 'TXT' }).click();
  const first = page.waitForRequest((r) => r.url().endsWith('/api/v1/exports') && r.method() === 'POST');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  expect((await first).postDataJSON()).not.toHaveProperty('candidatesOnly');
  await dialog.getByRole('switch', { name: 'Also include registered and unresolved names' }).click();
  const second = page.waitForRequest((r) => r.url().endsWith('/api/v1/exports') && r.method() === 'POST');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  expect((await second).postDataJSON()).toMatchObject({ format: 'txt', candidatesOnly: false });
});

test('catalog refresh items are providers, not domains', async ({ page }) => {
  const id = uuid(0x801);
  const catalogItem = (providerId: string, n: number) => ({
    id: uuid(0x810 + n),
    jobId: id,
    subject: providerId,
    unicode: providerId,
    suffix: null,
    operation: 'catalog',
    target: providerId,
    source: `provider:${providerId}`,
    state: 'finished',
    attempts: 1,
    outcome: 'updated',
    resolved: true,
    error: null,
    retryAt: null,
    startedAt: NOW,
    finishedAt: NOW,
    // Catalog prices are browsed through the provider catalog endpoint, not job evidence.
    evidence: { registry: null, confirmation: null, offers: [], nameCheck: null, diagnostic: null, listing: null },
    bestPrice: null,
    collectionIds: [],
  });
  await mockApi(page, {
    'GET /jobs/:id': () =>
      ok(job(id, { type: 'catalog_refresh', label: 'Catalog refresh', counters: { total: 2, pending: 0, running: 0, finished: 2, interrupted: 0, resolved: 2, unresolved: 0, outcomes: { updated: 2 } } })),
    'GET /jobs/:id/results': () => paged([catalogItem('porkbun', 1), catalogItem('dynadot', 2)]),
  });
  await page.goto(`/jobs/${id}`);
  await expect(page.getByRole('checkbox', { name: 'Select porkbun' })).toBeVisible();
  // Rows do not open a domain panel, and domain bulk actions are not offered.
  await expect(page.getByRole('button', { name: 'porkbun', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Select porkbun' }).click();
  const toolbar = page.getByRole('toolbar', { name: 'Selected results' });
  await expect(toolbar).toContainText('1 selected');
  await expect(toolbar.getByRole('button', { name: 'Shortlist' })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Export' })).toBeVisible();
});
