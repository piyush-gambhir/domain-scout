import { expect, test } from './fixtures';
import { COLLECTION, label24, mockRichDomain, mockShortlists } from './layout-fixtures';

// Route fixtures only: shortlist entries and evidence are simulated; nothing is sent anywhere.

test.use({ viewport: { width: 1280, height: 800 } });

test('entry notes stay editable when the table is narrow or the detail panel is open', async ({ page }) => {
  await mockShortlists(page);
  await mockRichDomain(page);
  await page.goto(`/collections/${COLLECTION}`);
  const domain = `${label24(1)}.com`;
  // Too narrow for the notes text column, so each entry keeps a notes button.
  await page.getByRole('button', { name: `Add notes for ${domain}` }).click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Notes' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: domain, exact: true }).click();
  await expect(page.getByRole('complementary', { name: domain })).toBeVisible();
  const noted = `${label24(0)}.si`;
  await page.getByRole('button', { name: `Edit notes for ${noted}` }).click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Notes' })).toHaveValue('Short, easy to say');
});
