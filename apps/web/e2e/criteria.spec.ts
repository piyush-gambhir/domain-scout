import { expect, test } from './fixtures';
import { JOB_ID, mockJobApi } from './mock-job';
import { EARLIER, NOW, PROVIDERS, SETTINGS, job, mockApi, ok, paged, startedWork, uuid } from './mock-api';

// Saved criteria (S08) through route fixtures: saving and restoring never start work, and the only
// request that would run anything (POST /jobs after pressing Run) is answered by a fixture.

function savedCriteria(body: Record<string, unknown>) {
  return {
    status: 201,
    json: {
      contractVersion: '1.0.0',
      data: { id: uuid(0x901), filter: null, extensions: [], providerIds: [], budget: null, generation: null, input: null, ...body, createdAt: NOW, updatedAt: NOW },
    },
  };
}

test('saving criteria from job results stores the filter, providers and budget', async ({ page }) => {
  await mockJobApi(page);
  const saved: unknown[] = [];
  const calls = await mockApi(page, {
    'GET /providers': () => paged(PROVIDERS),
    'GET /settings': () => ok(SETTINGS),
    'POST /criteria': (c) => {
      saved.push(c.body);
      return savedCriteria(c.body as Record<string, unknown>);
    },
  });
  // Providers chosen with earlier criteria arrive in the URL and start selected; the price cap
  // starts as the budget.
  await page.goto(`/jobs/${JOB_ID}?providers=porkbun&maxPrice=15&priceCurrency=EUR`);
  await page.getByRole('group', { name: 'Filter by outcome' }).getByRole('button', { name: /No record/ }).click();
  await expect(page).toHaveURL(/outcomes=no_record/);

  await page.getByRole('button', { name: 'More job actions' }).click();
  await page.getByRole('menuitem', { name: 'Save criteria' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save criteria' });
  await expect(dialog).toContainText('Outcome No record');
  await expect(dialog.getByRole('checkbox', { name: 'Porkbun' })).toBeChecked();
  await expect(dialog.getByLabel('Budget (first year)')).toHaveValue('15');
  await expect(dialog.getByLabel('Currency')).toHaveValue('EUR');
  await dialog.getByRole('checkbox', { name: 'Dynadot' }).click();
  await dialog.getByLabel('Criteria name').fill('Cheap no record');
  await dialog.getByLabel('Budget (first year)').fill('12.5x');
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await dialog.getByLabel('Budget (first year)').fill('12.50');
  await dialog.getByLabel('Currency').fill('usd');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  // Clearing the budget removes the price cap from what is saved.
  await page.getByRole('button', { name: 'More job actions' }).click();
  await page.getByRole('menuitem', { name: 'Save criteria' }).click();
  await dialog.getByLabel('Criteria name').fill('Any price');
  await dialog.getByLabel('Budget (first year)').fill('');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  const common = { filter: { outcomes: ['no_record'] }, extensions: ['test'], input: null };
  expect(saved).toEqual([
    { ...common, name: 'Cheap no record', providerIds: ['porkbun', 'dynadot'], budget: { amount: '12.50', currency: 'USD' } },
    { ...common, name: 'Any price', providerIds: ['porkbun'], budget: null },
  ]);
  expect(startedWork(calls)).toEqual([]);
});

test('restoring criteria on the scan page fills every field without running anything', async ({ page }) => {
  const criteriaId = uuid(0x902);
  const jobId = uuid(0x903);
  const saved: unknown[] = [];
  const calls = await mockApi(page, {
    'GET /providers': () => paged(PROVIDERS),
    'GET /settings': () => ok(SETTINGS),
    'GET /criteria/:id': () =>
      ok({
        id: criteriaId,
        name: 'Launch',
        filter: { outcomes: ['no_record'], confirmations: ['available'], inCollection: false, maxPrice: '99', priceCurrency: 'USD', sort: 'price', order: 'asc' },
        extensions: ['com'],
        providerIds: ['porkbun'],
        budget: { amount: '20', currency: 'EUR' },
        generation: null,
        input: 'example\nnic.si',
        createdAt: EARLIER,
        updatedAt: EARLIER,
      }),
    'POST /criteria': (c) => {
      saved.push(c.body);
      return savedCriteria(c.body as Record<string, unknown>);
    },
    'POST /jobs': () => ({ status: 201, json: { contractVersion: '1.0.0', data: job(jobId, { state: 'queued', label: 'Launch' }) } }),
    'GET /jobs/:id': (_c, p) => ok(job(p.id!, { label: 'Launch' })),
    'GET /jobs/:id/results': () => paged([]),
  });

  await page.goto(`/scan?criteria=${criteriaId}`);
  await expect(page.getByLabel('Domains or names')).toHaveValue('example\nnic.si');
  await expect(page).toHaveURL(/\/scan$/);
  await expect(page.getByRole('button', { name: 'Remove .com' })).toBeVisible();
  await expect(page.getByLabel('Budget (first year)')).toHaveValue('20');
  await expect(page.getByLabel('Currency')).toHaveValue('EUR');
  await expect(page.getByRole('button', { name: /^Providers/ })).toContainText('1');
  const filter = page.getByTestId('restored-filter');
  await expect(filter).toContainText('Outcome No record');
  await expect(filter).toContainText('Provider Available');
  await expect(filter).toContainText('Sorted by price');
  await expect(filter).toContainText('Not shortlisted');
  // The budget replaces the saved price cap, so the old cap is not shown as a second limit.
  await expect(filter).not.toContainText('99');
  expect(startedWork(calls)).toEqual([]);

  // Saving from the scan page stores the same fields.
  await page.getByRole('button', { name: 'Save criteria' }).click();
  await page.getByLabel('Criteria name').fill('Launch copy');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toEqual({
    name: 'Launch copy',
    input: 'example\nnic.si',
    extensions: ['com'],
    filter: { outcomes: ['no_record'], confirmations: ['available'], inCollection: false, sort: 'price' },
    providerIds: ['porkbun'],
    budget: { amount: '20', currency: 'EUR' },
  });
  expect(startedWork(calls)).toEqual([]);

  // Running scans registries only; the results open with the budget as the price cap.
  await page.getByRole('button', { name: /^Run \d+ checks?$/ }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}\\?`));
  const url = new URL(page.url());
  expect(url.searchParams.get('outcomes')).toBe('no_record');
  expect(url.searchParams.get('confirmations')).toBe('available');
  expect(url.searchParams.get('sort')).toBe('price');
  expect(url.searchParams.get('maxPrice')).toBe('20');
  expect(url.searchParams.get('priceCurrency')).toBe('EUR');
  expect(url.searchParams.get('providers')).toBe('porkbun');
  expect(url.searchParams.get('inCollection')).toBe('false');
  // The results view sends every restored criterion to the backend.
  await expect
    .poll(() => {
      const query = calls.filter((c) => c.path === `/jobs/${jobId}/results`).at(-1)?.search;
      return query ? Object.fromEntries(['outcomes', 'confirmations', 'inCollection', 'maxPrice', 'priceCurrency', 'sort'].map((k) => [k, query.get(k)])) : null;
    })
    .toEqual({ outcomes: 'no_record', confirmations: 'available', inCollection: 'false', maxPrice: '20', priceCurrency: 'EUR', sort: 'price' });
  const runs = startedWork(calls);
  expect(runs.map((c) => c.path)).toEqual(['/jobs']);
  expect(runs[0]!.body).toMatchObject({ type: 'registry_scan', input: { extensions: ['com'] } });
  expect(JSON.stringify(runs[0]!.body)).not.toContain('porkbun');
});

test('criteria saved from CSV input keep the values of the column read', async ({ page }) => {
  const saved: unknown[] = [];
  await mockApi(page, {
    'GET /providers': () => paged(PROVIDERS),
    'GET /settings': () => ok(SETTINGS),
    'POST /criteria': (c) => {
      saved.push(c.body);
      return savedCriteria(c.body as Record<string, unknown>);
    },
  });
  await page.goto('/scan');
  // Local preview only (the real backend parses the CSV); nothing is run.
  await page.getByLabel('Domains or names').fill('domain,target\ngoogle.com,example.com\nbbc.co.uk,nic.si');
  await page.getByRole('combobox', { name: 'Format' }).click();
  await page.getByRole('option', { name: 'CSV' }).click();
  await page.getByLabel('CSV column').fill('target');
  await expect(page.getByTestId('count-valid')).toHaveText('2');
  await expect(page.getByRole('list').filter({ hasText: 'example.com' })).toContainText('nic.si');
  await page.getByRole('button', { name: 'Save criteria' }).click();
  await page.getByLabel('Criteria name').fill('Targets');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({ name: 'Targets', input: 'example.com\nnic.si' });

  // Forced CSV without a column reads the first one.
  await page.getByLabel('CSV column').fill('');
  await expect(page.getByRole('list').filter({ hasText: 'google.com' })).toContainText('bbc.co.uk');
  await page.getByRole('button', { name: 'Save criteria' }).click();
  await page.getByLabel('Criteria name').fill('Domains');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => saved.length).toBe(2);
  expect(saved[1]).toMatchObject({ name: 'Domains', input: 'google.com\nbbc.co.uk' });
});
