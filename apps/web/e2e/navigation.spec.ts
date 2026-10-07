import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';
import { GIB, SMALL_SEARCH, buildJob, mockApp } from './app-fixtures';
import { label24 } from './layout-fixtures';
import { uuid } from './mock-api';

// Navigation follows the tasks: Search, Saved, Watching, History, with Settings at the bottom. Old
// module URLs redirect to where their content lives now.

test('the sidebar has the four tasks plus Settings, and marks the current one', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByTestId('sidebar');
  const main = sidebar.getByRole('navigation', { name: 'Main' });
  await expect(main.getByRole('link')).toHaveText([/^Search/, /^Saved/, /^Watching/, /^History/]);
  await expect(sidebar.getByRole('link', { name: 'Search' })).toHaveAttribute('aria-current', 'page');

  const pages: [name: RegExp, url: RegExp][] = [
    [/^Saved/, /\/saved$/],
    [/^Watching/, /\/watching$/],
    [/^History/, /\/history$/],
    [/^Settings$/, /\/settings\/providers$/],
    [/^Search$/, /\/$/],
  ];
  for (const [name, url] of pages) {
    await sidebar.getByRole('link', { name }).click();
    await expect(page).toHaveURL(url);
    await expect(sidebar.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
  }
  await expect(page.getByRole('textbox', { name: 'Search names or domains' })).toBeVisible();
});

test('the Saved badge counts saved names', async ({ page }) => {
  await mockApp(page, { lists: [{ name: 'Saved', domains: ['example.com', `${GIB[0]}.io`, `${GIB[1]}.dev`] }, { name: 'Other', domains: ['nic.si'] }] });
  await page.goto('/');
  await expect(page.getByTestId('sidebar').getByRole('link', { name: /^Saved/ })).toContainText('4');
});

test('Cmd/Ctrl+B collapses the sidebar to a rail and the choice persists', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByTestId('sidebar');
  const width = () => sidebar.evaluate((el) => el.getBoundingClientRect().width);
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');
  await expect.poll(width).toBeGreaterThan(200);
  // Focus leaves the search bar first; the shortcut works from anywhere but rich text.
  await page.getByRole('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+b');
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  await expect.poll(width).toBeLessThan(64);
  await sidebar.getByRole('link', { name: 'History' }).hover();
  await expect(page.getByRole('tooltip', { name: 'History' })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('sidebar')).toHaveAttribute('data-state', 'collapsed');
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(page.getByTestId('sidebar')).toHaveAttribute('data-state', 'expanded');
});

test('the theme menu switches between light and dark and persists', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/history');
  const html = page.locator('html');
  await expect(html).not.toHaveClass(/\bdark\b/);
  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(html).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);
  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Light' }).click();
  await expect(html).not.toHaveClass(/\bdark\b/);
});

test('the command palette opens with Cmd/Ctrl+K and navigates', async ({ page }) => {
  await page.goto('/history');
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('watching');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/watching$/);
  await expect(palette).toBeHidden();
});

test('the skip link moves focus to the main content', async ({ page }) => {
  await page.goto('/history');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
});

test('old module URLs redirect to their new places', async ({ page }) => {
  const id = uuid(0xe901);
  const moved: [from: string, to: RegExp][] = [
    ['/scan', /\/$/],
    ['/jobs', /\/history$/],
    [`/jobs/${id}`, new RegExp(`/search/${id}$`)],
    ['/collections', /\/saved$/],
    [`/collections/${id}`, new RegExp(`/saved/${id}$`)],
    ['/compare', /\/saved$/],
    ['/monitoring', /\/watching$/],
    [`/monitoring/${id}`, new RegExp(`/watching/${id}$`)],
    ['/providers', /\/settings\/providers$/],
    ['/providers?p=dynadot', /\/settings\/providers\?p=dynadot$/],
    ['/settings?section=pricing', /\/settings\/preferences$/],
    ['/settings?section=artifacts', /\/settings\/exports$/],
    ['/settings', /\/settings\/providers$/],
    ['/history?view=prices', /\/settings\/prices$/],
  ];
  for (const [from, to] of moved) {
    await page.goto(from);
    await expect(page, from).toHaveURL(to);
  }
  // Discover is the ideas mode of Search.
  await page.goto('/discover');
  await expect(page.getByRole('textbox', { name: 'Keywords' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ideas' })).toHaveAttribute('aria-pressed', 'true');
});

test.describe('signing in with a next path', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  async function bootstrapCode(): Promise<string> {
    const token = (await readFile(path.join(process.env.DS_E2E_DATA_DIR!, 'run/api-token'), 'utf8')).trim();
    const response = await fetch(`${process.env.DS_E2E_BACKEND_URL}/api/v1/auth/bootstrap-codes`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    return ((await response.json()) as { data: { code: string } }).data.code;
  }

  test('opens a same-origin path after sign-in and ignores anything else', async ({ page }) => {
    test.skip(process.env.DS_E2E_SESSION !== 'cookie' || !process.env.DS_E2E_DATA_DIR, 'Backend issued no session during setup');
    await page.goto(`/auth/bootstrap?code=${encodeURIComponent(await bootstrapCode())}&next=${encodeURIComponent('/history')}`);
    await expect(page).toHaveURL(/\/history$/);
    await expect(page.getByRole('heading', { level: 1, name: /History/ })).toBeVisible();

    for (const next of ['//evil.example/x', 'https://evil.example/', '/\\evil.example']) {
      await page.goto(`/auth/bootstrap?code=${encodeURIComponent(await bootstrapCode())}&next=${encodeURIComponent(next)}`);
      await expect(page, next).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    }
  });
});

test('keyboard: / focuses search, arrows move between cells, b opens Buy, Enter opens details and Esc closes them', async ({ page }) => {
  const id = uuid(0xe902);
  await mockApp(page, { jobs: [buildJob(id, SMALL_SEARCH, ['com', 'io', 'dev'])] });
  await page.goto(`/search/${id}`);
  await expect(page.getByTestId('grid-cell').first()).toBeVisible();

  await page.keyboard.press('/');
  await expect(page.getByRole('textbox', { name: 'Search names or domains' })).toBeFocused();

  // One tab stop for the whole grid; arrows move it.
  await page.locator('[data-cell="0:0"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-cell="0:1"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const free = page.getByRole('button', { name: new RegExp(`^${GIB[0]}\\.dev:`) });
  await expect(free).toBeFocused();
  await expect(free).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: new RegExp(`^${GIB[1]}\\.dev:`) })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(free).toBeFocused();

  await page.keyboard.press('b');
  const menu = page.getByRole('menu', { name: `Buy ${GIB[0]}.dev` });
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId('buy-link').first()).toHaveAttribute('href', `https://porkbun.provider.invalid/checkout?domain=${GIB[0]}.dev`);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  await free.focus();
  await page.keyboard.press('Enter');
  const dock = page.getByRole('complementary', { name: `${GIB[0]}.dev` });
  await expect(dock).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`d=${GIB[0]}\\.dev`));
  await page.keyboard.press('Escape');
  await expect(dock).toHaveCount(0);
  await expect(page).not.toHaveURL(/d=/);
});

test('keyboard: arrows move between list rows and Enter opens the row', async ({ page }) => {
  const id = uuid(0xe903);
  const names = Array.from({ length: 40 }, (_, i) => label24(i + 2000)).join('\n');
  await mockApp(page, { jobs: [buildJob(id, names, ['com'])] });
  await page.goto(`/search/${id}`);
  const rows = page.getByTestId('result-row');
  await expect(rows.first()).toBeVisible();
  const first = (await rows.nth(0).getAttribute('data-domain'))!;
  const second = (await rows.nth(1).getAttribute('data-domain'))!;
  await rows.nth(0).getByRole('button', { name: first, exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1).getByRole('button', { name: second, exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: second })).toBeVisible();
});
