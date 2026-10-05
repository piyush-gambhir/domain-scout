import { defineConfig, devices } from '@playwright/test';

/*
 * End-to-end tests run against a real local backend (apps/backend/dist/main.js) and `next start`,
 * both started by e2e/global-setup.ts on random loopback ports with a temporary data directory.
 * Build first: `pnpm turbo run build --filter @domain-scout/backend --filter @domain-scout/web`.
 * Set DS_E2E_NEXT=dev to use `next dev` instead of a production build.
 * No test sends candidate names to the network.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
});
