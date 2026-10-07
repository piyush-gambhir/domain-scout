import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { expand, mockApp, outcomeOf } from './app-fixtures';
import { label24 } from './layout-fixtures';

// Journey 2, "triage a list": 300 pasted names become a list grouped by what can be done with them,
// cheapest unregistered names first. The search itself is a fixture; nothing reaches a registry.

const NAMES = Array.from({ length: 300 }, (_, i) => label24(i + 1000));
const TEXT = NAMES.join('\n');
const EXTENSIONS = ['com', 'io'];
const DOMAINS = expand(TEXT, EXTENSIONS).map((d) => d.domain);
const FREE = DOMAINS.filter((d) => outcomeOf(d) === 'no_record');
const TAKEN = DOMAINS.filter((d) => outcomeOf(d) === 'registered');
const PROBLEM = DOMAINS.filter((d) => ['rate_limited', 'inconclusive'].includes(outcomeOf(d)));

async function pasteList(page: Page) {
  const fixture = await mockApp(page);
  await page.goto('/');
  // Start from two extensions so 300 names make 600 checks.
  const chips = page.getByRole('group', { name: 'Extensions' });
  for (const ext of ['dev', 'app', 'co', 'ai']) await chips.getByRole('button', { name: `Remove .${ext}`, exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Search names or domains' });
  await input.fill(TEXT);
  await expect(page.getByTestId('search-preview')).toContainText('600 checks');
  await input.press('Enter');
  await expect(page.getByTestId('result-row').first()).toBeVisible({ timeout: 15_000 });
  return fixture;
}

function resultQueries(calls: Awaited<ReturnType<typeof mockApp>>['calls']) {
  return calls.filter((c) => c.method === 'GET' && /^\/jobs\/[^/]+\/results$/.test(c.path)).map((c) => c.search);
}

/** Scrolls the virtualized list until a section header renders. */
async function revealSection(page: Page, group: string) {
  const header = page.getByTestId(`section-${group}`);
  for (let i = 0; i < 20 && !(await header.isVisible()); i++) {
    await page.getByTestId('results-scroll').evaluate((el) => el.scrollBy(0, 2000));
    await page.waitForTimeout(80);
  }
  return header;
}

function firstPrice(text: string): number {
  const match = /\$(\d+\.\d\d)/.exec(text);
  return match ? Number(match[1]) : Infinity;
}

test('a pasted list opens grouped: not registered cheapest first, taken collapsed, then what could not be checked', async ({ page }) => {
  await pasteList(page);
  expect(FREE.length).toBeGreaterThan(200);
  const free = page.getByTestId('section-free');
  await expect(free).toContainText(`Not registered${FREE.length}`);
  await expect(free.getByRole('button', { name: /Not registered/ })).toHaveAttribute('aria-expanded', 'true');
  const taken = await revealSection(page, 'taken');
  await expect(taken).toContainText(`Taken${TAKEN.length}`);
  await expect(taken.getByRole('button', { name: /Taken/ })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('section-problem')).toContainText(`Couldn't check${PROBLEM.length}`);

  // Cheapest first: the first rows' first-year prices never go down.
  await page.getByTestId('results-scroll').evaluate((el) => el.scrollTo(0, 0));
  const rows = page.getByTestId('result-row');
  const prices: number[] = [];
  for (let i = 0; i < 8; i++) prices.push(firstPrice(await rows.nth(i).innerText()));
  expect(prices.every((p) => Number.isFinite(p))).toBe(true);
  expect([...prices].sort((a, b) => a - b)).toEqual(prices);

  // Taken names open on request.
  await (await revealSection(page, 'taken')).getByRole('button', { name: /Taken/ }).click();
  await expect(page.getByTestId('section-taken').getByRole('button', { name: /Taken/ })).toHaveAttribute('aria-expanded', 'true');

  // Honest, quiet wording: no "Available", no warning-colored "Stale".
  await expect(page.getByText(/\bAvailable\b/)).toHaveCount(0);
  await expect(page.getByText(/\bStale\b/)).toHaveCount(0);
});

test('filters narrow every section, and the price cap applies only to names that can be registered', async ({ page }) => {
  const { calls } = await pasteList(page);
  await page.getByRole('search', { name: 'Filter results' }).getByRole('button', { name: 'Extension', exact: true }).click();
  await page.getByRole('checkbox', { name: '.com', exact: true }).click();
  await page.keyboard.press('Escape');
  // Escape closes the extension picker; its own Clear button must be gone before the bar's Clear is used.
  await expect(page.getByRole('checkbox', { name: '.com', exact: true })).toHaveCount(0);
  await expect.poll(() => resultQueries(calls).some((q) => q.get('suffixes') === 'com' && q.get('outcomes') === 'no_record')).toBe(true);
  await expect(page).toHaveURL(/suffixes=com/);
  const freeCom = FREE.filter((d) => d.endsWith('.com')).length;
  await expect(page.getByTestId('section-free')).toContainText(`Not registered${freeCom}`);

  await page.getByRole('textbox', { name: 'Maximum first-year price in USD' }).fill('12');
  await expect.poll(() => resultQueries(calls).some((q) => q.get('maxPrice') === '12')).toBe(true);
  const capped = resultQueries(calls).filter((q) => q.get('maxPrice') === '12');
  expect(capped.every((q) => q.get('outcomes') === 'no_record' && q.get('priceCurrency') === 'USD')).toBe(true);
  expect(resultQueries(calls).some((q) => q.get('outcomes') === 'registered' && q.has('maxPrice'))).toBe(false);

  // Every name here is 24 characters, so a 10-character cap leaves nothing.
  await page.getByRole('textbox', { name: 'Maximum name length' }).fill('10');
  await expect.poll(() => resultQueries(calls).some((q) => q.get('maxLength') === '10')).toBe(true);
  await expect(page.getByText('None match these filters.').first()).toBeVisible();

  await page.getByRole('search', { name: 'Filter results' }).getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page).not.toHaveURL(/suffixes=|maxPrice=|maxLength=/);
  await expect(page.getByTestId('section-free')).toContainText(`Not registered${FREE.length}`);
});

test('a whole section is selected past the loaded page and saved to a new list', async ({ page }) => {
  const { calls } = await pasteList(page);
  await page.getByRole('checkbox', { name: 'Select loaded Not registered rows' }).click();
  const toolbar = page.getByRole('toolbar', { name: 'Selected results' });
  await expect(toolbar).toContainText('200 selected');
  await page.getByRole('button', { name: `Select all ${FREE.length}` }).click();
  await expect(toolbar).toContainText(`${FREE.length} selected`);

  await toolbar.getByRole('button', { name: 'Save' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`${FREE.length} domains`);
  await dialog.getByRole('textbox', { name: 'Shortlist name' }).fill('Launch picks');
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(dialog).toBeHidden();
  const added = calls.find((c) => c.method === 'POST' && /^\/collections\/[^/]+\/entries$/.test(c.path));
  expect(new Set((added?.body as { domains: string[] }).domains)).toEqual(new Set(FREE));
  expect(calls.find((c) => c.method === 'POST' && c.path === '/collections')?.body).toEqual({ name: 'Launch picks' });
});

test('checking selected names again sends only those names', async ({ page }) => {
  const { calls } = await pasteList(page);
  const rows = page.getByTestId('result-row');
  const a = (await rows.nth(0).getAttribute('data-domain'))!;
  const b = (await rows.nth(2).getAttribute('data-domain'))!;
  await page.getByRole('checkbox', { name: `Select ${a}` }).click();
  await page.getByRole('checkbox', { name: `Select ${b}` }).click();
  const toolbar = page.getByRole('toolbar', { name: 'Selected results' });
  await expect(toolbar).toContainText('2 selected');
  await toolbar.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => calls.filter((c) => c.method === 'POST' && c.path === '/rechecks').length).toBe(1);
  expect((calls.find((c) => c.path === '/rechecks')?.body as { domains: string[] }).domains).toEqual([a, b]);
  // Changing the filter clears the selection, so bulk actions never reach rows that are not shown.
  await page.getByRole('searchbox', { name: 'Filter names' }).fill(a.slice(0, 6));
  await expect(toolbar).toBeHidden();
});

test('the list stays virtualized and loads the next page as it scrolls', async ({ page }) => {
  const { calls } = await pasteList(page);
  const rendered = await page.getByTestId('result-row').count();
  expect(rendered).toBeGreaterThan(5);
  expect(rendered).toBeLessThan(80);
  await page.getByTestId('results-scroll').hover();
  for (let i = 0; i < 30 && !resultQueries(calls).some((q) => q.get('outcomes') === 'no_record' && q.get('cursor') === '200'); i++) {
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(100);
  }
  expect(resultQueries(calls).some((q) => q.get('outcomes') === 'no_record' && q.get('cursor') === '200')).toBe(true);
  expect(await page.getByTestId('result-row').count()).toBeLessThan(80);
  // The document never scrolled; the list pane did.
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
});

test('grid and list views switch from the toolbar and the choice stays in the URL', async ({ page }) => {
  await pasteList(page);
  const view = page.getByRole('radiogroup', { name: 'View' });
  await view.getByRole('radio', { name: 'Grid' }).click();
  await expect(page).toHaveURL(/view=grid/);
  await expect(page.getByTestId('grid-cell').first()).toBeVisible();
  await view.getByRole('radio', { name: 'List' }).click();
  await expect(page).toHaveURL(/view=list/);
  await expect(page.getByTestId('result-row').first()).toBeVisible();
});
