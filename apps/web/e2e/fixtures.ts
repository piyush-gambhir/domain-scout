import { test as base, expect, type Page } from '@playwright/test';

/** Base URL and session storage come from global setup (random ports, temporary data directory). */
export const test = base.extend({
  baseURL: async ({}, use) => {
    await use(process.env.DS_E2E_WEB_URL);
  },
  storageState: async ({}, use) => {
    await use(process.env.DS_E2E_STORAGE);
  },
});

export { expect };

/** CSRF header for direct API calls made with the page's session. */
export async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const cookie = (await page.context().cookies()).find((c) => c.name === 'ds_csrf');
  return cookie ? { 'X-CSRF-Token': cookie.value } : {};
}
