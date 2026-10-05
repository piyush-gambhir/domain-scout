import { expect, test } from './fixtures';
import { LATER, NOW, PROVIDERS, mockApi, ok, paged, uuid } from './mock-api';

// Offer presentation (P02, P10) from a route fixture: the domain page reads retained evidence only.

const DOMAIN = 'example.com';

function offer(overrides: Record<string, unknown>) {
  return {
    id: uuid(0x601),
    providerId: 'dynadot',
    domain: DOMAIN,
    suffix: 'com',
    purchasePath: 'new_registration',
    kind: 'exact_quote',
    currency: 'USD',
    region: null,
    registration: { amount: '1.99', years: 1 },
    minYears: null,
    renewal: { amount: '45.98', years: 2 },
    transfer: { amount: null, includesYears: null },
    fees: { icann: '0.20', other: [], tax: 'unknown' },
    premium: { status: 'not_premium', registration: null, renewal: null },
    promotion: {
      description: 'First year sale',
      requiresTermYears: 2,
      restrictions: 'New customers only',
      expiresAt: '2026-11-01T12:00:00.000Z',
      eligibilityVerified: false,
    },
    observedAt: NOW,
    publishedAt: null,
    quoteExpiresAt: null,
    staleAt: LATER,
    freshness: 'fresh',
    source: { label: 'Dynadot quote', url: null },
    destination: null,
    ...overrides,
  };
}

test('offers show renewal with its own years and promotion terms as supplied', async ({ page }) => {
  await mockApi(page, {
    'GET /providers': () => paged(PROVIDERS),
    'GET /domains/:name/evidence': () =>
      ok({
        domain: DOMAIN,
        unicode: DOMAIN,
        suffix: 'com',
        registry: [],
        confirmations: [],
        offers: [
          offer({}),
          offer({
            id: uuid(0x602),
            providerId: 'porkbun',
            domain: null,
            kind: 'published',
            registration: { amount: '11.08', years: 1 },
            minYears: 2,
            renewal: { amount: '11.08', years: 1 },
            promotion: null,
            source: { label: 'Porkbun pricing', url: null },
          }),
        ],
        nameChecks: [],
        diagnostics: [],
        listings: [],
        collections: [],
        providers: [],
      }),
  });
  await page.goto(`/domains/${DOMAIN}`);
  const prices = page.getByRole('region', { name: 'Prices' });
  await expect(prices).toBeVisible();
  // No column pairs the registration term with the renewal amount.
  await expect(prices.getByRole('columnheader', { name: 'Term' })).toHaveCount(0);

  const promo = prices.getByRole('row').filter({ hasText: 'Dynadot' });
  await expect(promo.getByTestId('offer-registration')).toContainText('$1.99');
  await expect(promo.getByTestId('offer-registration')).toContainText('for 1 yr');
  await expect(promo.getByTestId('offer-renewal')).toContainText('$45.98');
  await expect(promo.getByTestId('offer-renewal')).toContainText('for 2 yr');
  const terms = promo.getByTestId('promotion');
  await expect(terms).toContainText('Promotion: First year sale');
  await expect(terms).toContainText('Requires 2 yr term');
  await expect(terms).toContainText('Restrictions: New customers only');
  await expect(terms).toContainText('Ends Nov 1, 2026');
  await expect(terms).toContainText('Eligibility not verified');

  const regular = prices.getByRole('row').filter({ hasText: 'Porkbun' });
  await expect(regular.getByTestId('promotion')).toHaveCount(0);
  await expect(regular.getByTestId('offer-registration')).toContainText('for 1 yr, minimum 2 yr');
  await expect(regular.getByTestId('offer-renewal')).toContainText('for 1 yr');
});
