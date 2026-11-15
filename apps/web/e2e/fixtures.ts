import { test as base, expect, type Page } from '@playwright/test';


export const test = base.extend({
  baseURL: async ({}, use) => {
    await use(process.env.DS_E2E_WEB_URL);
  },
  storageState: async ({}, use) => {
    await use(process.env.DS_E2E_STORAGE);
  },
});

export { expect };


export async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const cookie = (await page.context().cookies()).find((c) => c.name === 'ds_csrf');
  return cookie ? { 'X-CSRF-Token': cookie.value } : {};
}
