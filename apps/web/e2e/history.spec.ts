import { readFile } from 'node:fs/promises';
import type { BrowserContext, Download, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { GIB, SMALL_SEARCH, buildJob, mockApp } from './app-fixtures';
import { PHONE, mockApi, ok, pageOverflow, uuid, startedWork } from './mock-api';

// Journey 5, "review agent work": searches from this UI and from agents (the CLI) in one list, each
// reopening its results. Jobs are fixtures; the real backend has no finished searches.

const UI = uuid(0xe801);
const AGENT = uuid(0xe802);
const STOPPED = uuid(0xe803);
const SYSTEM = uuid(0xe804);
const SIX = ['com', 'io', 'dev', 'app', 'co', 'ai'];

function jobs() {
  const stopped = buildJob(STOPPED, `${GIB[1]} ${GIB[2]}`, ['com', 'io'], { label: 'Stopped search', running: 1 });
  Object.assign(stopped.job, { state: 'interrupted', destinations: ['rdap.verisign.com', 'rdap.arnes.si'] });
  const system = buildJob(SYSTEM, GIB[0], ['com'], { label: 'Catalog refresh', origin: 'system' });
  system.job.type = 'catalog_refresh';
  return [buildJob(UI, SMALL_SEARCH, SIX, { label: 'Launch names' }), buildJob(AGENT, `${GIB[1]} ${GIB[2]}`, SIX, { label: 'Agent shortlist', origin: 'cli' }), stopped, system];
}

async function open(page: Page) {
  const fixture = await mockApp(page, { jobs: jobs() });
  await page.goto('/history');
  await expect(page.getByRole('heading', { level: 1, name: /History/ })).toBeVisible();
  return fixture;
}

test('history shows searches from this UI and from agents, with what each found', async ({ page }) => {
  const { calls } = await open(page);
  const rows = page.getByTestId('history-row');
  await expect(rows).toHaveCount(3);
  expect(calls.find((c) => c.path === '/history')?.search.get('origins')).toBe('ui,cli');
  await expect(rows.filter({ hasText: 'Agent shortlist' })).toContainText('Agent');
  await expect(rows.filter({ hasText: 'Launch names' })).not.toContainText('Agent');
  // The summary says how many names can be registered, from the history entry's own counts.
  await expect(rows.filter({ hasText: 'Launch names' })).toContainText(/\d+ not registered of 20/);
  await expect(rows.filter({ hasText: 'Agent shortlist' })).toContainText('not registered of 12');
  expect(calls.some((c) => c.method === 'GET' && c.path === '/jobs')).toBe(false);
  await expect(rows.filter({ hasText: 'Catalog refresh' })).toHaveCount(0);

  // System and watch jobs appear on request, with a type filter.
  await page.getByRole('switch', { name: 'System and watch jobs' }).click();
  await expect(rows).toHaveCount(4);
  expect(calls.filter((c) => c.path === '/history').at(-1)?.search.has('origins')).toBe(false);
  await page.getByRole('combobox', { name: 'Type' }).click();
  await page.getByRole('option', { name: 'Catalog refresh' }).click();
  await expect(rows).toHaveCount(1);
  expect(calls.filter((c) => c.path === '/history').at(-1)?.search.get('type')).toBe('catalog_refresh');
});

test('opening an agent search restores its results view', async ({ page }) => {
  await open(page);
  await page.getByRole('link', { name: 'Agent shortlist' }).click();
  await expect(page).toHaveURL(new RegExp(`/search/${AGENT}$`));
  await expect(page.getByRole('grid', { name: 'Results by name and extension' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search names or domains' })).toHaveValue(`${GIB[1]} ${GIB[2]}`);
});

test('stopped searches resume after naming where names go, and finished ones delete after confirming', async ({ page }) => {
  const { calls } = await open(page);
  const resumes = await mockApi(page, { 'POST /jobs/:id/resume': (_c, p) => ok({ ...jobs()[2]!.job, id: p.id, state: 'running' }) });
  const stopped = page.getByTestId('history-row').filter({ hasText: 'Stopped search' });
  await expect(stopped).toContainText('Interrupted');
  // Resuming contacts the job's destinations again; they are named before the click.
  await expect(stopped.getByTestId('resume-destinations')).toContainText('rdap.verisign.com, rdap.arnes.si');
  await stopped.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText('Resumed Stopped search')).toBeVisible();
  expect(resumes.some((c) => c.method === 'POST' && c.path === `/jobs/${STOPPED}/resume`)).toBe(true);

  await page.getByRole('button', { name: 'More actions for Launch names' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete Launch names?' });
  await expect(dialog).toBeVisible();
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('history-row').filter({ hasText: 'Launch names' })).toHaveCount(0);
  expect(calls.some((c) => c.method === 'DELETE' && c.path === `/jobs/${UI}`)).toBe(true);
});

test('"Search again with these names" fills the search bar without running anything', async ({ page }) => {
  const { calls } = await open(page);
  await page.getByRole('button', { name: 'More actions for Launch names' }).click();
  await page.getByRole('menuitem', { name: 'Search again with these names' }).click();
  await expect(page.getByRole('textbox', { name: 'Search names or domains' })).toHaveValue(SMALL_SEARCH);
  expect(startedWork(calls)).toEqual([]);
});

/** Picks a format from an export menu and returns the downloaded file's name and text. */
async function exportAs(page: Page, format: 'JSON' | 'CSV'): Promise<{ name: string; text: string }> {
  await page.getByRole('button', { name: 'Export history' }).click();
  const download: Promise<Download> = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: format }).click();
  const file = await download;
  return { name: file.suggestedFilename(), text: await readFile((await file.path())!, 'utf8') };
}

/** Exported history is built from API data only: no session or CSRF cookie values. */
async function expectNoCredentials(context: BrowserContext, text: string) {
  for (const cookie of await context.cookies()) expect(text).not.toContain(cookie.value);
  expect(text).not.toMatch(/ds_session|ds_csrf|authorization|bearer/i);
}

test('exports the listed searches as JSON and CSV without requesting anything', async ({ page, context }) => {
  const { calls } = await open(page);
  await expect(page.getByTestId('history-row')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Export history' })).toBeEnabled();
  const requests = calls.length;

  const json = await exportAs(page, 'JSON');
  expect(json.name).toMatch(/^domain-scout-job-history-all-\d{8}T\d{6}Z\.json$/);
  const doc = JSON.parse(json.text);
  expect(doc).toMatchObject({ kind: 'domain-scout-job-history', contractVersion: '1.0.0', scope: { q: null, type: null }, loadedJobs: 3, totalJobs: 3, complete: true });
  expect(doc.jobs.map((j: { jobId: string }) => j.jobId)).toContain(AGENT);
  await expectNoCredentials(context, json.text);

  const csv = await exportAs(page, 'CSV');
  const lines = csv.text.trimEnd().split('\r\n');
  expect(lines[0]).toBe('jobId,type,label,state,createdAt,finishedAt,total,unresolved,extensions,destinations,resumable');
  expect(lines).toHaveLength(4);
  await expectNoCredentials(context, csv.text);
  expect(calls.length).toBe(requests);
});

test('an empty history offers a search', async ({ page }) => {
  await mockApp(page);
  await page.goto('/history');
  await expect(page.getByText('No searches yet.')).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test.describe('at 375px', () => {
  test.use({ viewport: PHONE });
  test('history fits without sideways scrolling', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('history-row').first()).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });
});
