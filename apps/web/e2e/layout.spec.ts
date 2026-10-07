import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { EARLIER, GIB, buildJob, mockApp, type AppOptions } from './app-fixtures';
import { BIG_WATCH, label24, mockBigMonitoring, mockManyPriceSeries, mockRichDomain } from './layout-fixtures';
import { mockSettings } from './page-fixtures';
import { uuid } from './mock-api';

/*
 * The app fills the window at desktop widths: the document never scrolls, <main> never overflows,
 * and lists that grow (results, saved names, watches, notices, history, coverage) scroll inside their
 * own pane. Every route is checked at 1440x900 and 1280x800 with enough data to overflow its lists.
 * Set DS_SCREENSHOTS=<dir> to also save light, dark and 390x844 screenshots for visual review, and
 * DS_LAYOUT_REPORT=<file> to append each measurement as a JSON line.
 */

const GRID = uuid(0xe1);
const GRID_BIG = uuid(0xe2);
const LIST = uuid(0xe3);
const RUNNING = uuid(0xe4);
// Only the fixed test set and full 24-character gibberish labels, even though nothing leaves the page.
const SMALL_TEXT = `${GIB.join(' ')} example.com google.com`;
const GRID_TEXT = [...GIB, ...Array.from({ length: 26 }, (_, i) => label24(i)), 'example.com'].join('\n');
const LIST_TEXT = Array.from({ length: 300 }, (_, i) => label24(i + 100)).join('\n');
const EXT = ['com', 'io', 'dev', 'app', 'co', 'ai'];

const SAVED_DOMAINS = Array.from({ length: 60 }, (_, i) => `${label24(i + 500)}.${EXT[i % EXT.length]}`);

function app(extra: AppOptions = {}): (page: Page) => Promise<unknown> {
  return (page) =>
    mockApp(page, {
      jobs: [
        buildJob(GRID, SMALL_TEXT, EXT, { label: 'Launch names' }),
        buildJob(GRID_BIG, GRID_TEXT, EXT, { label: 'Thirty names' }),
        buildJob(LIST, LIST_TEXT, ['com', 'io'], { label: 'launch-list.csv' }),
        buildJob(RUNNING, SMALL_TEXT, EXT, { label: 'Launch names', running: 9 }),
        ...Array.from({ length: 56 }, (_, i) =>
          buildJob(uuid(0xf00 + i), `${label24(i + 900)} ${GIB[i % 3]}`, i % 2 ? ['com', 'io'] : EXT, {
            label: `${label24(i + 900)} and 1 more`,
            origin: i % 3 === 0 ? 'cli' : 'ui',
            createdAt: EARLIER,
          }),
        ),
      ],
      lists: [
        { name: 'Saved', domains: SAVED_DOMAINS },
        { name: 'Launch shortlist', domains: SAVED_DOMAINS.slice(0, 8) },
      ],
      staleSaved: SAVED_DOMAINS.filter((_, i) => i % 3 === 0),
      ...extra,
    });
}

interface Case {
  name: string;
  path: string;
  setup?: (page: Page) => Promise<unknown>;
  /** Visible once the page has its data. */
  ready: (page: Page) => Locator;
  /** Interactions before measuring, e.g. typing or expanding a row. */
  prepare?: (page: Page) => Promise<void>;
  /** Elements inside each growing list; the nearest scrolling ancestor must overflow and scroll. */
  lists?: string[];
  /** Below lg details open as pages: readiness differs there. */
  mobileReady?: (page: Page) => Locator;
}

const CASES: Case[] = [
  { name: 'home', path: '/', setup: app(), ready: (page) => page.getByTestId('recent-search').first() },
  {
    name: 'home-typing',
    path: '/',
    setup: app(),
    ready: (page) => page.getByRole('textbox', { name: 'Search names or domains' }),
    prepare: async (page) => {
      await page.getByRole('textbox', { name: 'Search names or domains' }).fill(`${GIB[0]} ${GIB[1]}`);
      await expect(page.getByTestId('search-preview')).toContainText('12 checks');
    },
  },
  {
    name: 'home-ideas',
    path: '/?mode=ideas',
    setup: app(),
    ready: (page) => page.getByRole('textbox', { name: 'Keywords' }),
    prepare: async (page) => {
      // Generation is local to the backend; nothing is checked.
      await page.getByRole('textbox', { name: 'Keywords' }).fill('scout trail summit');
      await expect(page.getByRole('list', { name: 'Ideas' }).getByRole('listitem').nth(30)).toBeVisible();
      await page.getByRole('checkbox', { name: 'Select scouttrail' }).check();
    },
    lists: ['ul[aria-label="Ideas"] li'],
  },
  { name: 'results-grid', path: `/search/${GRID}`, setup: app(), ready: (page) => page.getByTestId('grid-cell').first() },
  {
    name: 'results-buy',
    path: `/search/${GRID}`,
    setup: app(),
    ready: (page) => page.getByTestId('grid-cell').first(),
    prepare: async (page) => {
      await page.locator(`[data-domain="${GIB[0]}.dev"] button[data-cell]`).focus();
      await page.keyboard.press('b');
      await expect(page.getByRole('menu')).toBeVisible();
    },
  },
  {
    name: 'results-grid-large',
    path: `/search/${GRID_BIG}`,
    setup: app(),
    ready: (page) => page.getByTestId('grid-cell').first(),
    lists: ['[data-testid="results-grid"] [role="row"]'],
  },
  { name: 'results-running', path: `/search/${RUNNING}`, setup: app(), ready: (page) => page.getByTestId('search-progress') },
  {
    name: 'results-list',
    path: `/search/${LIST}`,
    setup: app(),
    ready: (page) => page.getByTestId('result-row').first(),
    lists: ['[data-testid="results-scroll"] [data-testid="result-row"]'],
  },
  {
    name: 'results-dock',
    path: `/search/${GRID}?d=${GIB[0]}.dev`,
    setup: app(),
    ready: (page) => page.getByRole('complementary', { name: `${GIB[0]}.dev` }).getByTestId('price-row').first(),
    mobileReady: (page) => page.getByTestId('grid-cell').first(),
  },
  {
    name: 'results-list-dock',
    path: `/search/${LIST}?d=${label24(100)}.com`,
    setup: app(),
    ready: (page) => page.getByRole('complementary').getByTestId('domain-status'),
    mobileReady: (page) => page.getByTestId('result-row').first(),
    lists: ['[data-testid="results-scroll"] [data-testid="result-row"]'],
  },
  {
    name: 'domain',
    path: '/domains/nic.si',
    setup: async (page) => {
      await app()(page);
      await mockRichDomain(page);
    },
    ready: (page) => page.getByTestId('domain-status'),
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Registry details' }).click();
    },
  },
  {
    name: 'saved',
    path: '/saved',
    setup: app(),
    ready: (page) => page.getByTestId('saved-row').first(),
    lists: ['[data-testid="entries-scroll"] [data-testid="saved-row"]'],
  },
  {
    name: 'saved-compare',
    path: '/saved',
    setup: app(),
    ready: (page) => page.getByTestId('saved-row').first(),
    prepare: async (page) => {
      // Only names that can be registered offer a cost comparison.
      await page.getByRole('button', { name: /^Compare provider costs for / }).first().click();
      await expect(page.getByTestId('comparison-row').first()).toBeVisible();
    },
    lists: ['[data-testid="entries-scroll"] [data-testid="saved-row"]'],
  },
  { name: 'saved-owned', path: '/saved/owned', setup: app(), ready: (page) => page.getByLabel('CSV') },
  {
    name: 'saved-empty',
    path: '/saved',
    setup: (page) => mockApp(page),
    ready: (page) => page.getByText('Nothing saved yet.'),
  },
  {
    name: 'watching',
    path: '/watching',
    setup: mockBigMonitoring,
    ready: (page) => page.getByRole('link', { name: 'Fixture watch 16' }),
    lists: ['ul[aria-label="Watch list"] li', 'ul[aria-label="Notice list"] li'],
  },
  {
    name: 'watch',
    path: `/watching/${BIG_WATCH}`,
    setup: mockBigMonitoring,
    ready: (page) => page.getByTestId('watch-run').first(),
    lists: ['[data-testid="watch-run"]', 'ul[aria-label="Notice list"] li', 'ul[aria-label="Watched names"] li'],
  },
  { name: 'history', path: '/history', setup: app(), ready: (page) => page.getByTestId('history-row').first(), lists: ['[data-testid="history-row"]'] },
  {
    name: 'settings-providers',
    path: '/settings/providers',
    ready: (page) => page.getByRole('article'),
    mobileReady: (page) => page.getByRole('button', { name: /Registry directories/ }),
  },
  ...(['preferences', 'checks', 'data', 'exports', 'service'] as const).map(
    (section): Case => ({
      name: `settings-${section}`,
      path: `/settings/${section}`,
      setup: mockSettings,
      ready: (page) =>
        ({
          preferences: page.getByRole('radiogroup', { name: 'Theme' }),
          checks: page.getByLabel('Checks in flight'),
          data: page.getByRole('button', { name: 'Delete selected data' }),
          exports: page.getByText('No snapshots.'),
          service: page.getByText('MCP adapter'),
        })[section],
    }),
  ),
  { name: 'settings-prices', path: '/settings/prices', setup: mockManyPriceSeries, ready: (page) => page.getByTestId('price-series').first(), lists: ['[data-testid="price-series"]'] },
  {
    name: 'settings-coverage',
    path: '/settings/coverage',
    ready: (page) => page.getByTestId('coverage-row').nth(30),
    lists: ['[data-testid="coverage-row"]'],
  },
];

interface Measure {
  page: number;
  main: number;
  lists: { selector: string; found: boolean; overflow: number; scrolls: boolean; inMain: boolean; bottom: number }[];
  innerHeight: number;
}

/** Nearest ancestor that scrolls vertically, measured in the page. */
async function measure(page: Page, lists: string[]): Promise<Measure> {
  return page.evaluate(
    ({ lists }) => {
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
      };
    },
    { lists },
  );
}

const SHOTS = process.env.DS_SCREENSHOTS;

async function open(page: Page, item: Case, mobile = false) {
  await item.setup?.(page);
  await page.goto(item.path);
  await expect((mobile && item.mobileReady ? item.mobileReady : item.ready)(page)).toBeVisible({ timeout: 15_000 });
  if (!(mobile && item.mobileReady)) await item.prepare?.(page);
  // Let fonts, transitions and resize observers settle.
  await page.waitForTimeout(300);
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
        const result = await measure(page, item.lists ?? []);
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
