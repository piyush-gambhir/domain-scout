import { expect, test } from './fixtures';
import { JOB_ID, TOTAL, domainAt, mockJobApi } from './mock-job';

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
