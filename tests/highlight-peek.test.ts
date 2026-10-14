/**
 * The tab peek's forced hide (docs/specs/SPEC-interaction-highlight.md §16.5;
 * review round 2, items A and C).
 *
 * A peek attaches a Page object of its own, and the ring on the tab may be
 * another process's altogether — a CLI run on the same CDP browser — so the
 * forced path hides whatever is there, with no record of a draw to go by.
 * What keeps it cheap is that it asks only frames with a document, for a few
 * synchronous DOM writes each, under a short budget.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { HIGHLIGHT_DEFAULTS, HIGHLIGHT_TAG, drawRings, hiddenFor } from '../src/browser/highlight.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

const visibility = (page: import('playwright').Page): Promise<string | null> =>
  page.evaluate((tag) => {
    const host = document.documentElement.querySelector(`:scope > ${tag}`);
    return host ? getComputedStyle(host).visibility : null;
  }, HIGHLIGHT_TAG);

describe('hiddenFor with force', () => {
  it('writes nothing on a tab Steptix never drew on (review round 3, item 5)', async () => {
    // Nothing in this file stamps the process-wide record, so this is the
    // highlight-never-used path: a peek of the user's own tab.
    const page = await browser.newPage();
    try {
      await page.setContent('<p>the user\'s own tab</p>');
      expect(await hiddenFor(page, async () => 'shot', { force: true })).toBe('shot');
      const keys = await page.evaluate(() => Object.getOwnPropertySymbols(document.documentElement).map(String));
      expect(keys).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('hides a ring this process has no record of drawing', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button id="go">Go</button>');
      // Drawn without a highlighter, so nothing in this module recorded it:
      // what a ring another process drew looks like from here.
      expect(await drawRings(page.locator('#go'), 'act', { ...HIGHLIGHT_DEFAULTS, durationMs: 10_000 })).toBe(1);
      expect(await hiddenFor(page, () => visibility(page))).toBe('visible');
      expect(await hiddenFor(page, () => visibility(page), { force: true })).toBe('hidden');
      expect(await visibility(page)).toBe('visible');
    } finally {
      await page.close();
    }
  });

  // A frame with no document of its own yet (here a response that never
  // arrives): an evaluation inside it would wait for a document that may never
  // come. It is asked through its <iframe> element in the parent instead, which
  // reaches its initial document at once (review 21; review 23, item 1).
  it('never enters the context of a frame with no document, and takes the picture at once', async () => {
    const page = await browser.newPage();
    try {
      // A third-party frame whose response never arrives.
      await page.route('http://hang.test/**', () => { /* never answered */ });
      await page.route('http://main.test/', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<p>main</p><iframe src="http://hang.test/ad"></iframe>' }));
      await page.goto('http://main.test/', { waitUntil: 'domcontentloaded' });
      const pending = page.frames().find((frame) => frame !== page.mainFrame())!;
      expect(pending.url()).toBe('');
      const asked = vi.spyOn(pending, 'evaluate');
      const main = vi.spyOn(page.mainFrame(), 'evaluate');
      expect(await hiddenFor(page, async () => 'shot', { force: true })).toBe('shot');
      expect(asked).not.toHaveBeenCalled();
      expect(main).toHaveBeenCalled();
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.close();
    }
  });
});
