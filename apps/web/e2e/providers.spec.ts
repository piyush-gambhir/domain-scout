import { expect, test } from './fixtures';
import { NOW, PROVIDERS, mockApi, ok, paged, provider } from './mock-api';

// Credential setup, test and disconnect (R09) against route fixtures: no provider API is called and
// the fixture backend, like the real one, never returns a secret.

const SECRET = 'fixture-secret-7d1e9b4c2a';

const NOT_CONFIGURED = {
  configured: false,
  storage: null as string | null,
  storageLocation: null,
  fields: [{ key: 'apiKey', set: false }],
  lastTestedAt: null as string | null,
  lastTestResult: null as string | null,
  lastTestMessage: null as string | null,
};

test('credentials are typed masked, never shown after saving, then tested and disconnected', async ({ page, context }) => {
  let credentials = { ...NOT_CONFIGURED };
  const dynadot = () => ({
    ...provider('dynadot', 'Dynadot', ['api.dynadot.com']),
    credentialFields: [{ key: 'apiKey', label: 'API key', secret: true, required: true, help: null, envVar: 'DOMAIN_SCOUT_DYNADOT_API_KEY' }],
    credentials,
    readiness: credentials.configured ? 'ready' : 'credentials_missing',
  });
  const calls = await mockApi(page, {
    'GET /providers': () => paged([PROVIDERS[0], dynadot(), PROVIDERS[2]]),
    'PUT /providers/:id/credentials': (c) => {
      const body = c.body as { storage: string };
      credentials = { ...credentials, configured: true, storage: body.storage, fields: [{ key: 'apiKey', set: true }] };
      return ok(dynadot());
    },
    'POST /providers/:id/credentials/test': () => {
      credentials = { ...credentials, lastTestedAt: NOW, lastTestResult: 'ok', lastTestMessage: 'Account balance read' };
      return ok({ result: 'ok', testedAt: NOW, operation: 'account balance', message: 'Credentials accepted' });
    },
    'DELETE /providers/:id/credentials': () => {
      credentials = { ...NOT_CONFIGURED };
      return ok(dynadot());
    },
  });

  await page.goto('/settings/providers?p=dynadot');
  const section = page.getByRole('article', { name: 'Dynadot' }).getByRole('region', { name: 'Credentials' });
  await expect(section).toContainText('Not configured');
  const field = section.getByLabel('API key');
  await expect(field).toHaveAttribute('type', 'password');
  await expect(section.getByRole('button', { name: 'Test' })).toBeDisabled();

  await field.fill(SECRET);
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(section).toContainText('Configured');
  await expect(section).toContainText('this session only');
  const put = calls.find((c) => c.method === 'PUT' && c.path === '/providers/dynadot/credentials');
  expect(put?.body).toEqual({ values: { apiKey: SECRET }, storage: 'session' });

  // The saved value leaves the form and is not rendered or stored anywhere in the page.
  await expect(field).toHaveValue('');
  await expect(field).toHaveAttribute('placeholder', 'Saved');
  expect(await page.content()).not.toContain(SECRET);
  const values = await page.locator('input, textarea').evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
  expect(values).not.toContain(SECRET);
  const stored = await page.evaluate(() => JSON.stringify({ ...window.localStorage, ...window.sessionStorage }));
  expect(stored).not.toContain(SECRET);
  expect((await context.cookies()).some((c) => c.value.includes(SECRET))).toBe(false);

  await section.getByRole('button', { name: 'Test' }).click();
  await expect(page.getByText('Credentials accepted')).toBeVisible();
  await expect(section).toContainText('Passed');
  await expect(section).toContainText('Account balance read');
  expect(calls.filter((c) => c.method === 'POST' && c.path === '/providers/dynadot/credentials/test')).toHaveLength(1);

  await section.getByRole('button', { name: 'Disconnect' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Disconnect Dynadot?' });
  await expect(confirm).toBeVisible();
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  await confirm.getByRole('button', { name: 'Disconnect' }).click();
  await expect(section).toContainText('Not configured');
  expect(calls.filter((c) => c.method === 'DELETE' && c.path === '/providers/dynadot/credentials')).toHaveLength(1);
  expect(await page.content()).not.toContain(SECRET);
});
