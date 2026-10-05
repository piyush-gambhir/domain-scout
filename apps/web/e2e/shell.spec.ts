import { expect, test } from './fixtures';

const PAGES: [link: RegExp, path: string, title: string][] = [
  [/^Discover$/, '/discover', 'Discover'],
  [/^Jobs$/, '/jobs', 'Jobs'],
  [/^History$/, '/history', 'History'],
  [/^Shortlists$/, '/collections', 'Shortlists'],
  [/^Compare$/, '/compare', 'Compare'],
  [/^Monitor/, '/monitoring', 'Monitor'],
  [/^Providers$/, '/providers', 'Providers'],
  [/^Settings$/, '/settings', 'Settings'],
  [/^Scan$/, '/scan', 'Scan'],
];

test('sidebar navigates to every page', async ({ page }) => {
  await page.goto('/scan');
  await expect(page.getByRole('heading', { level: 1, name: 'Scan' })).toBeVisible();
  const sidebar = page.getByTestId('sidebar');
  for (const [link, path, title] of PAGES) {
    await sidebar.getByRole('link', { name: link }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: link })).toHaveAttribute('aria-current', 'page');
  }
});

test('Cmd/Ctrl+B collapses the sidebar to a rail and the choice persists', async ({ page }) => {
  await page.goto('/scan');
  const sidebar = page.getByTestId('sidebar');
  const width = () => sidebar.evaluate((el) => el.getBoundingClientRect().width);
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');
  await expect.poll(width).toBeGreaterThan(200);

  await page.keyboard.press('ControlOrMeta+b');
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  // Icon rail: labels become screen-reader only.
  await expect.poll(width).toBeLessThan(64);
  // Links keep their accessible names in rail mode, and show a tooltip on hover.
  await sidebar.getByRole('link', { name: 'Jobs' }).hover();
  await expect(page.getByRole('tooltip', { name: 'Jobs' })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('sidebar')).toHaveAttribute('data-state', 'collapsed');
  await expect.poll(width).toBeLessThan(64);

  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.getByTestId('sidebar')).toHaveAttribute('data-state', 'expanded');
});

test('theme menu switches between light and dark and persists', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/scan');
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

test('command palette opens with Cmd/Ctrl+K and navigates', async ({ page }) => {
  await page.goto('/scan');
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('shortlists');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/collections$/);
  await expect(palette).toBeHidden();
});

test('skip link moves focus to the main content', async ({ page }) => {
  await page.goto('/scan');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
});
