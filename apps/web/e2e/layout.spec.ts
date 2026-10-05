import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { BIG_WATCH, COLLECTION, label24, mockBigMonitoring, mockJobsList, mockManyPriceSeries, mockRichDomain, mockShortlists } from './layout-fixtures';
import { mockHistory, mockPrices, mockSettings } from './page-fixtures';
import { JOB_ID, mockJobApi } from './mock-job';

/*
 * The app fills the window at desktop widths: the document never scrolls, <main> never overflows,
 * and lists that grow (results, candidates, providers, coverage, notices) scroll inside their own
 * pane. Every route is checked at 1440x900 and 1280x800 with enough data to overflow its lists.
 * Real backend data where it is local (providers directory, coverage, settings), fixtures elsewhere.
 * Set DS_SCREENSHOTS=<dir> to also save light, dark and 390x844 screenshots for visual review, and
 * DS_LAYOUT_REPORT=<file> to append each measurement as a JSON line.
 */

interface Case {
  name: string;
  path: string;
  setup?: (page: Page) => Promise<unknown>;
  /** Visible once the page has its data. */
  ready: (page: Page) => Locator;
  /** Interactions before measuring, e.g. filling an input or expanding a group. */
  prepare?: (page: Page) => Promise<void>;
  /** Elements inside each growing list; the nearest scrolling ancestor must overflow and scroll. */
  lists?: string[];
  /** Elements whose scrolling pane must fit without scrolling. */
  fits?: string[];
  /** Below lg details open as pages and master-detail shows one side: readiness differs there. */
  mobileReady?: (page: Page) => Locator;
}

const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });

const CASES: Case[] = [
  {
    name: 'scan',
    path: '/scan',
    ready: (page) => heading(page, 'Scan'),
    prepare: async (page) => {
      // Local preview only: 400 random 24-character names, never run.
      await page.getByLabel('Domains or names').fill(Array.from({ length: 400 }, (_, i) => `${label24(i)}.com`).join('\n'));
      await expect(page.getByTestId('count-valid')).toHaveText('400');
    },
    lists: ['section[aria-label="Preview"] ul li'],
  },
  {
    name: 'discover',
    path: '/discover',
    ready: (page) => heading(page, 'Discover'),
    prepare: async (page) => {
      // Generation is local; a bundled theme produces a long candidate list.
      await page.getByRole('group', { name: 'Themes' }).getByRole('button').first().click();
      await expect(page.getByRole('list', { name: 'Candidate list' }).getByRole('listitem').nth(40)).toBeVisible();
    },
    lists: ['ul[aria-label="Candidate list"] li'],
  },
  { name: 'jobs', path: '/jobs', setup: mockJobsList, ready: (page) => page.getByRole('link', { name: /Fixture scan 2/ }).first(), lists: ['ul[aria-label="Jobs"] li'] },
  {
    name: 'job',
    path: `/jobs/${JOB_ID}`,
    setup: mockJobApi,
    ready: (page) => page.getByText('1,500 results'),
    lists: ['[data-testid="results-scroll"] [role="row"][data-row-index]'],
  },
  {
    name: 'job-detail',
    path: `/jobs/${JOB_ID}?d=nic.si`,
    setup: async (page) => {
      await mockJobApi(page);
      await mockRichDomain(page);
    },
    ready: (page) => page.getByRole('complementary', { name: 'nic.si' }).getByRole('region', { name: 'Registry', exact: true }),
    mobileReady: (page) => page.getByText('1,500 results'),
    prepare: async (page) => {
      const dock = page.getByRole('complementary', { name: 'nic.si' });
      await dock.getByRole('tab', { name: 'Providers' }).click();
      await dock.getByRole('button', { name: /87 registrars from the \.si registry/ }).click();
    },
    lists: ['[data-testid="results-scroll"] [role="row"][data-row-index]', 'ul[aria-label="Registrars for .si"] li'],
  },
  {
    name: 'domain',
    path: '/domains/nic.si',
    setup: mockRichDomain,
    ready: (page) => page.getByRole('region', { name: 'Registry', exact: true }),
    prepare: async (page) => {
      await page.getByRole('button', { name: /87 registrars from the \.si registry/ }).click();
    },
    lists: ['ul[aria-label="Registrars for .si"] li'],
  },
  {
    name: 'providers',
    path: '/providers',
    ready: (page) => page.getByRole('article'),
    mobileReady: (page) => page.getByRole('button', { name: /Registry directories/ }),
    prepare: async (page) => {
      await page.getByRole('button', { name: /Registry directories/ }).click();
    },
    lists: ['nav[aria-label="Providers"] li'],
    fits: ['article'],
  },
  {
    name: 'providers-credentials',
    path: '/providers?p=dynadot',
    ready: (page) => page.getByRole('article', { name: 'Dynadot' }).getByRole('region', { name: 'Credentials' }),
    fits: ['article'],
  },
  {
    name: 'collections',
    path: '/collections',
    setup: mockShortlists,
    ready: (page) => page.getByRole('link', { name: /Fixture shortlist 30/ }),
    lists: ['ul[aria-label="Shortlist list"] li', 'section[aria-label="Saved criteria"] li'],
  },
  {
    name: 'collection',
    path: `/collections/${COLLECTION}`,
    setup: mockShortlists,
    ready: (page) => page.getByRole('checkbox', { name: `Select ${label24(3)}.si` }),
    lists: ['[data-testid="entries-scroll"] tbody tr'],
  },
  {
    name: 'collection-detail',
    path: `/collections/${COLLECTION}?d=nic.si`,
    setup: async (page) => {
      await mockShortlists(page);
      await mockRichDomain(page);
    },
    ready: (page) => page.getByRole('complementary', { name: 'nic.si' }).getByRole('region', { name: 'Registry', exact: true }),
    mobileReady: (page) => page.getByRole('checkbox', { name: `Select ${label24(3)}.si` }),
    lists: ['[data-testid="entries-scroll"] tbody tr'],
  },
  {
    name: 'monitoring',
    path: '/monitoring',
    setup: mockBigMonitoring,
    ready: (page) => page.getByRole('link', { name: 'Fixture watch 16' }),
    lists: ['ul[aria-label="Watch list"] li', 'ul[aria-label="Notice list"] li'],
  },
  {
    name: 'watch',
    path: `/monitoring/${BIG_WATCH}`,
    setup: mockBigMonitoring,
    ready: (page) => page.getByTestId('watch-run').first(),
    lists: ['[data-testid="watch-run"]', 'ul[aria-label="Notice list"] li', 'section[aria-label="Domains"] li'],
  },
  { name: 'history', path: '/history', setup: mockHistory, ready: (page) => page.getByTestId('history-row').first(), lists: ['[data-testid="history-row"]'] },
  {
    name: 'history-prices',
    path: '/history?view=prices',
    setup: mockManyPriceSeries,
    ready: (page) => page.getByTestId('price-series').first(),
    lists: ['[data-testid="price-series"]'],
  },
  {
    name: 'compare',
    path: '/compare?domains=example.com,google.com',
    setup: mockPrices,
    ready: (page) => page.getByTestId('comparison-row').first(),
  },
  {
    name: 'compare-transfer',
    path: '/compare?tab=transfer&domains=example.com,google.com',
    setup: mockPrices,
    ready: (page) => page.getByTestId('transfer-options').first(),
  },
  {
    name: 'compare-aftermarket',
    path: '/compare?tab=aftermarket&domains=example.com',
    setup: mockPrices,
    ready: (page) => page.getByTestId('listing'),
  },
  { name: 'compare-portfolio', path: '/compare?tab=portfolio', ready: (page) => page.getByLabel('CSV') },
  ...(['appearance', 'checks', 'pricing', 'privacy', 'data', 'artifacts', 'service'] as const).map(
    (section): Case => ({
      name: `settings-${section}`,
      path: section === 'appearance' ? '/settings' : `/settings?section=${section}`,
      setup: mockSettings,
      ready: (page) =>
        ({
          appearance: page.getByRole('radiogroup', { name: 'Theme' }),
          checks: page.getByLabel('Checks in flight'),
          pricing: page.getByLabel('Ownership horizon'),
          privacy: page.getByRole('switch'),
          data: page.getByRole('button', { name: 'Delete selected data' }),
          artifacts: page.getByText('No snapshots.'),
          service: page.getByText('MCP adapter'),
        })[section],
    }),
  ),
  {
    name: 'settings-coverage',
    path: '/settings?section=coverage',
    ready: (page) => page.getByTestId('coverage-row').nth(30),
    lists: ['[data-testid="coverage-row"]'],
  },
];

interface Measure {
  page: number;
  main: number;
  lists: { selector: string; found: boolean; overflow: number; scrolls: boolean; inMain: boolean; bottom: number }[];
  fits: { selector: string; found: boolean; overflow: number }[];
  innerHeight: number;
}

/** Nearest ancestor that scrolls vertically, measured in the page. */
async function measure(page: Page, lists: string[], fits: string[]): Promise<Measure> {
  return page.evaluate(
    ({ lists, fits }) => {
      const scrollParent = (element: Element | null): HTMLElement | null => {
        for (let el = element?.parentElement ?? null; el && el !== document.body; el = el.parentElement) {
          const overflowY = getComputedStyle(el).overflowY;
          if (overflowY === 'auto' || overflowY === 'scroll') return el;
        }
        return null;
      };
      const main = document.querySelector('main')!;
      return {
        page: document.scrollingElement!.scrollHeight - window.innerHeight,
        main: main.scrollHeight - main.clientHeight,
        innerHeight: window.innerHeight,
        lists: lists.map((selector) => {
          const pane = scrollParent(document.querySelector(selector));
          return {
            selector,
            found: Boolean(pane),
            overflow: pane ? pane.scrollHeight - pane.clientHeight : 0,
            scrolls: pane ? ['auto', 'scroll'].includes(getComputedStyle(pane).overflowY) : false,
            inMain: pane ? pane !== main && main.contains(pane) : false,
            bottom: pane ? pane.getBoundingClientRect().bottom : Infinity,
          };
        }),
        fits: fits.map((selector) => {
          const pane = scrollParent(document.querySelector(selector));
          return { selector, found: Boolean(pane), overflow: pane ? pane.scrollHeight - pane.clientHeight : 0 };
        }),
      };
    },
    { lists, fits },
  );
}

const SHOTS = process.env.DS_SCREENSHOTS;

async function open(page: Page, item: Case, mobile = false) {
  await item.setup?.(page);
  await page.goto(item.path);
  await expect((mobile && item.mobileReady ? item.mobileReady : item.ready)(page)).toBeVisible({ timeout: 15_000 });
  if (!(mobile && item.mobileReady)) await item.prepare?.(page);
  // Let fonts and resize observers settle.
  await page.waitForTimeout(250);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  test.describe(`layout at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });
    for (const item of CASES) {
      test(`${item.name} fits the window and scrolls only its lists`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' });
        await open(page, item);
        const result = await measure(page, item.lists ?? [], item.fits ?? []);
        if (process.env.DS_LAYOUT_REPORT) {
          appendFileSync(process.env.DS_LAYOUT_REPORT, `${JSON.stringify({ name: item.name, viewport: `${viewport.width}x${viewport.height}`, page: result.page, main: result.main, lists: result.lists.map((l) => l.overflow) })}\n`);
        }
        expect(result.page, 'document scrolls').toBeLessThanOrEqual(1);
        expect(result.main, 'main overflows').toBeLessThanOrEqual(1);
        for (const list of result.lists) {
          expect(list.found, `${list.selector} has a scrolling pane`).toBe(true);
          expect(list.inMain, `${list.selector} scrolls inside a pane, not main`).toBe(true);
          expect(list.scrolls, `${list.selector} pane scrolls`).toBe(true);
          expect(list.overflow, `${list.selector} overflows its pane`).toBeGreaterThan(0);
          expect(list.bottom, `${list.selector} pane ends inside the window`).toBeLessThanOrEqual(result.innerHeight + 1);
        }
        for (const fit of result.fits) {
          expect(fit.found, `${fit.selector} has a pane`).toBe(true);
          expect(fit.overflow, `${fit.selector} fits without scrolling`).toBeLessThanOrEqual(1);
        }

        if (SHOTS) {
          mkdirSync(SHOTS, { recursive: true });
          const base = path.join(SHOTS, `${item.name}-${viewport.width}x${viewport.height}`);
          await page.screenshot({ path: `${base}-light.png` });
          await page.emulateMedia({ colorScheme: 'dark' });
          await expect(page.locator('html')).toHaveClass(/\bdark\b/);
          await page.waitForTimeout(150);
          await page.screenshot({ path: `${base}-dark.png` });
        }
      });
    }
  });
}

test.describe('mobile layout at 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  for (const item of CASES) {
    test(`${item.name} has no sideways scroll`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await open(page, item, true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(SHOTS, `${item.name}-390x844.png`), fullPage: true });
      }
    });
  }
});
