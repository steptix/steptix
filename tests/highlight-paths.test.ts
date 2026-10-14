/**
 * The interaction highlight on the paths phase 2 added
 * (docs/specs/SPEC-interaction-highlight.md §2.2, §2.3, §4.2, §6, §11):
 *
 *  - the remaining `executeAction` handlers mark what they act on: both ends
 *    of a drag, a visible upload target (and nothing for a hidden input), a
 *    dismiss, the focused element under a keyboard action, a table read as
 *    one ring;
 *  - the result says which colour was asked for (`highlighted`, §11);
 *  - a compiled `step.read` / `step.count` marks through the run's sink;
 *  - the login broker's `typeInto` / `submitLogin` mark what they type into
 *    and press;
 *  - `inScreenshots: false` keeps rings out of report captures, a model's
 *    capture never has one, and `endRings` takes them down for good before
 *    `[use computer]`.
 *
 * A recording sink stands in for drawing wherever the question is "what was
 * marked"; the screenshot cases draw for real, under reduced motion so the
 * ring is static. Nothing waits on the clock: "drawn recently" runs on an
 * injected `now`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import Jimp from 'jimp';
import { executeAction } from '../src/browser/actions.js';
import {
  HIGHLIGHT_DEFAULTS,
  HIGHLIGHT_REGISTRY_KEY,
  HIGHLIGHT_TAG,
  createHighlighter,
  drawRings,
  endRings,
  lateRingWaitsPending,
  frameOfLocator,
  pageEverRinged,
  resetRingRecordsForTests,
  hiddenFor,
  reportAudience,
  ringsOutOfScreenshots,
  type HighlightKind,
  type HighlightSink,
  type ResolvedHighlight,
} from '../src/browser/highlight.js';
import { captureScreenshot } from '../src/browser/screenshot.js';
import { closeBrowser, type BrowserSession } from '../src/browser/manager.js';
import { captureDomSnapshot } from '../src/browser/dom-cleaner.js';
import { highlightingPage } from '../src/browser/highlight-page.js';
import { runCodeBehindEntry } from '../src/codebehind/execute.js';
import { submitLogin, typeInto } from '../src/credentials/login-fields.js';
import type { AIAction } from '../src/ai/types.js';
import { renderReport } from '../src/report/generator.js';
import type { SubActionResult, TestReport } from '../src/report/types.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

// "A ring is up somewhere in this process" is module state, and many cases
// here draw on a far-future clock: without this, every later case would read
// as drawn-recently whatever its own clock said, and pass vacuously.
beforeEach(() => {
  resetRingRecordsForTests();
});

async function pageWith(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
  return page;
}

function act(action: Omit<AIAction, 'description'>): AIAction {
  return { description: `${action.action} under test`, ...action } as AIAction;
}

interface Recorded { locator: Locator; kind: HighlightKind; max: number | undefined }

function recordingSink(): { sink: HighlightSink; marks: Recorded[] } {
  const marks: Recorded[] = [];
  return { sink: { mark: (locator, kind, max) => { marks.push({ locator, kind, max }); } }, marks };
}

/** Each mark as the ids of what its locator matches now. */
function resolved(marks: Recorded[]): Promise<Array<{ kind: HighlightKind; max: number | undefined; ids: string[] }>> {
  return Promise.all(marks.map(async (m) => ({
    kind: m.kind,
    max: m.max,
    ids: await m.locator.evaluateAll((els) => els.map((e) => e.id)),
  })));
}

async function marksOf(html: string, action: AIAction, prepare?: (page: Page) => Promise<void>) {
  const page = await pageWith(html);
  try {
    await prepare?.(page);
    const { sink, marks } = recordingSink();
    const result = await executeAction(page, action, undefined, undefined, { highlight: sink });
    return { result, marks: await resolved(marks) };
  } finally {
    await page.close();
  }
}

describe('the remaining handlers mark at the act (§2.2)', () => {
  it('drag: the source, then the destination', async () => {
    const { result, marks } = await marksOf(
      '<div id="item" draggable="true" style="width:60px;height:30px">Item</div>'
        + '<div id="host" style="width:120px;height:60px;margin-top:40px">Host</div>',
      act({ action: 'drag', selector: '#item', target: '#host' }),
    );
    expect(result.success).toBe(true);
    expect(marks).toEqual([
      { kind: 'act', max: undefined, ids: ['item'] },
      { kind: 'act', max: undefined, ids: ['host'] },
    ]);
  });

  describe('upload', () => {
    let dir: string;
    let file: string;

    beforeAll(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-highlight-upload-'));
      file = path.join(dir, 'notes.txt');
      await fs.writeFile(file, 'Ada', 'utf8');
    });

    afterAll(async () => {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    });

    it('marks a visible file input', async () => {
      const { result, marks } = await marksOf(
        '<input type="file" id="file">',
        act({ action: 'upload', selector: '#file', filePath: file }),
      );
      expect(result.success).toBe(true);
      expect(marks).toEqual([{ kind: 'act', max: undefined, ids: ['file'] }]);
    });

    it('marks nothing for a hidden file input, which has no box', async () => {
      const { result, marks } = await marksOf(
        '<input type="file" id="file" style="display:none">',
        act({ action: 'upload', selector: '#file', filePath: file }),
      );
      expect(result.success).toBe(true);
      expect(marks).toEqual([]);
      expect(result.highlighted).toBeUndefined();
    });
  });

  it('dismiss: the element clicked', async () => {
    const { result, marks } = await marksOf(
      '<div role="dialog"><button id="close-item">Close</button></div>',
      act({ action: 'dismiss', selector: '#close-item' }),
    );
    expect(result.success).toBe(true);
    expect(marks).toEqual([{ kind: 'act', max: undefined, ids: ['close-item'] }]);
  });

  it('keyboard: the focused element, the inner one when it is in an open shadow root', async () => {
    const plain = await marksOf(
      '<input id="name">',
      act({ action: 'keyboard', key: 'a' }),
      async (page) => { await page.focus('#name'); },
    );
    expect(plain.result.success).toBe(true);
    expect(plain.marks).toEqual([{ kind: 'act', max: undefined, ids: ['name'] }]);

    const shadowed = await marksOf(
      '<div id="host"></div>',
      act({ action: 'keyboard', key: 'a' }),
      async (page) => {
        await page.evaluate(() => {
          const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
          const input = document.createElement('input');
          input.id = 'inner';
          root.appendChild(input);
          input.focus();
        });
      },
    );
    expect(shadowed.result.success).toBe(true);
    expect(shadowed.marks).toEqual([{ kind: 'act', max: undefined, ids: ['inner'] }]);
  });

  it('readTable: one read ring, on the table, not one per cell', async () => {
    const { result, marks } = await marksOf(
      '<table id="grid"><thead><tr><th>Name</th><th>Order</th></tr></thead>'
        + '<tbody><tr><td>Ada</td><td>12</td></tr><tr><td>Bob</td><td>13</td></tr></tbody></table>',
      act({
        action: 'readTable',
        selector: '#grid',
        columns: [{ header: 'Name', key: 'name' }, { header: 'Order', key: 'order' }],
        as: 'rows',
      }),
    );
    expect(result.success).toBe(true);
    expect(marks).toEqual([{ kind: 'read', max: 1, ids: ['grid'] }]);
  });
});

describe('the result says what was asked for (§11)', () => {
  it('act for a click, read for a read, nothing without a sink', async () => {
    const html = '<button id="go">Go</button><p id="note">Order 12 was placed.</p>';
    expect((await marksOf(html, act({ action: 'click', selector: '#go' }))).result.highlighted).toBe('act');
    expect((await marksOf(html, act({ action: 'read', selector: '#note', as: 'n' }))).result.highlighted).toBe('read');
    const page = await pageWith(html);
    try {
      const plain = await executeAction(page, act({ action: 'click', selector: '#go' }));
      expect(plain.success).toBe(true);
      expect(plain.highlighted).toBeUndefined();
    } finally {
      await page.close();
    }
  });

  it('nothing for an action with no element', async () => {
    const { result } = await marksOf('<p>x</p>', act({ action: 'wait', waitType: 'duration', value: '1ms' }));
    expect(result.success).toBe(true);
    expect(result.highlighted).toBeUndefined();
  });
});

describe('a compiled step.read / step.count marks through the run\'s sink (§7.3)', () => {
  it('marks what it reads and counts', async () => {
    const page = await pageWith('<p class="row" id="r1">One</p><p class="row" id="r2">Two</p>');
    try {
      const { sink, marks } = recordingSink();
      const params: Record<string, string> = {};
      const outcome = await runCodeBehindEntry({
        binding: {
          file: path.join(os.tmpdir(), 'x.steps.ts'),
          source: 'Read the rows',
          occurrence: 0,
          scope: { renames: {}, inputs: {} },
          entry: {
            source: 'Read the rows',
            run: async ({ step }) => {
              await step.read({ selector: '#r1', as: 'first' });
              await step.count({ selector: '.row', as: 'n' });
            },
          },
        },
        page,
        context: page.context(),
        browser,
        resolvedParameters: params,
        label: 'test',
        readTimeoutMs: 1_000,
        highlight: sink,
      });
      expect(outcome.status).toBe('passed');
      expect(params).toMatchObject({ first: 'One', n: '2' });
      expect(await resolved(marks)).toEqual([
        { kind: 'read', max: undefined, ids: ['r1'] },
        { kind: 'read', max: 20, ids: ['r1', 'r2'] },
      ]);
    } finally {
      await page.close();
    }
  });
});

describe('the login broker marks what it types into and presses (§2.3)', () => {
  it('typeInto marks the field; submitLogin the control, or the field it presses Enter in', async () => {
    const page = await pageWith(
      '<form onsubmit="event.preventDefault()"><input id="user"><button id="send" type="submit">Send</button></form>',
    );
    try {
      const { sink, marks } = recordingSink();
      await typeInto(page.mainFrame(), '#user', 'Ada', sink);
      await submitLogin(page.mainFrame(), '#send', '#user', sink);
      await submitLogin(page.mainFrame(), null, '#user', sink);
      expect(await resolved(marks)).toEqual([
        { kind: 'act', max: undefined, ids: ['user'] },
        { kind: 'act', max: undefined, ids: ['send'] },
        { kind: 'act', max: undefined, ids: ['user'] },
      ]);
    } finally {
      await page.close();
    }
  });
});

// ── Screenshots ──────────────────────────────────────────────────────────────

const STATIC: ResolvedHighlight = { ...HIGHLIGHT_DEFAULTS, durationMs: 10_000, colors: { ...HIGHLIGHT_DEFAULTS.colors } };
const RING: [number, number, number] = [0x3b, 0x82, 0xf6];
const BACKGROUND: [number, number, number] = [255, 255, 255];

const SHOT_PAGE = '<!doctype html><html><body style="margin:0;background:#ffffff">'
  + '<button id="go" style="position:absolute;left:100px;top:100px;width:80px;height:30px">Go</button>'
  + '</body></html>';

/** A page with one static ring drawn by `settings`, on a fake clock at 1000. */
async function ringedPage(settings: ResolvedHighlight): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
  await page.setContent(SHOT_PAGE);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  createHighlighter(settings, { now: () => 1_000 }).mark(page.locator('#go'), 'act');
  await page.waitForFunction(({ tag, key }) => {
    const host = document.documentElement.querySelector(`:scope > ${tag}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return host !== null && (host as any)[Symbol.for(key)].rings().length === 1;
  }, { tag: HIGHLIGHT_TAG, key: HIGHLIGHT_REGISTRY_KEY });
  return page;
}

/** The middle of the ring's left edge: the button's left, outset 3, plus 1. */
async function ringPixel(base64: string | undefined): Promise<[number, number, number]> {
  const image = await Jimp.read(Buffer.from(base64!, 'base64'));
  const { r, g, b } = Jimp.intToRGBA(image.getPixelColor(98, 115));
  return [r, g, b];
}

function near(actual: [number, number, number], expected: [number, number, number]): boolean {
  return actual.every((v, i) => Math.abs(v - expected[i]!) <= 12);
}

describe('who sees the rings in a screenshot (§4.2)', () => {
  // `captureScreenshot` asks "drawn recently?" on the real clock, so these
  // rings are drawn on a clock at the far end of time: on any machine,
  // however loaded, the real one never reaches their end.
  async function ringedNow(settings: ResolvedHighlight): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
    await page.setContent(SHOT_PAGE);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    createHighlighter(settings, { now: () => 8.64e15 }).mark(page.locator('#go'), 'act');
    await page.waitForFunction(({ tag, key }) => {
      const host = document.documentElement.querySelector(`:scope > ${tag}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return host !== null && (host as any)[Symbol.for(key)].rings().length === 1;
    }, { tag: HIGHLIGHT_TAG, key: HIGHLIGHT_REGISTRY_KEY });
    return page;
  }

  it('a report capture shows the ring by default; a model capture never does', async () => {
    const page = await ringedNow(STATIC);
    try {
      expect(near(await ringPixel((await captureScreenshot(page))?.base64), RING)).toBe(true);
      expect(near(await ringPixel((await captureScreenshot(page, false, 'model'))?.base64), BACKGROUND)).toBe(true);
      // And the model's capture put it back for the person watching.
      expect(near(await ringPixel((await captureScreenshot(page))?.base64), RING)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('inScreenshots: false keeps it out of report captures too', async () => {
    const page = await ringedNow({ ...STATIC, inScreenshots: false });
    try {
      expect(near(await ringPixel((await captureScreenshot(page))?.base64), BACKGROUND)).toBe(true);
      // Hidden for the capture, not ended: the page still has its ring.
      const live = await page.evaluate(({ tag, key }) => {
        const host = document.documentElement.querySelector(`:scope > ${tag}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return host ? (host as any)[Symbol.for(key)].rings().filter((r: { hidden: boolean }) => !r.hidden).length : 0;
      }, { tag: HIGHLIGHT_TAG, key: HIGHLIGHT_REGISTRY_KEY });
      expect(live).toBe(1);
    } finally {
      await page.close();
    }
  });
});

describe('[use computer] takes the rings down for good (§6 item 1)', () => {
  it('endRings ends every ring on the pages it is given, and skips pages with none', async () => {
    const page = await ringedPage(STATIC);
    const untouched = await pageWith('<p>no rings here</p>');
    try {
      await endRings([page, untouched], { now: () => 1_000 });
      expect(await page.evaluate((tag) => document.documentElement.querySelector(`:scope > ${tag}`) !== null, HIGHLIGHT_TAG))
        .toBe(false);
    } finally {
      await page.close();
      await untouched.close();
    }
  });
});

describe('the report carries what was asked for (§11)', () => {
  function reportWith(subActions: SubActionResult[]): TestReport {
    return {
      testName: 'Highlight report',
      filePath: path.resolve(path.sep, 'proj', 'tests', 'highlight.md'),
      tags: [],
      status: 'passed',
      steps: [{
        instruction: 'Sign in',
        status: 'passed',
        turns: [{ turnNumber: 1, attemptNumber: 1, timestamp: '2026-10-14T00:00:00.000Z', aiInteractions: [], subActions }],
        durationMs: 10,
        retried: false,
      }],
      totalSteps: 1,
      passedSteps: 1,
      failedSteps: 0,
      totalSubActions: subActions.length,
      durationMs: 100,
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      date: '2026-10-14T00:00:00.000Z',
    };
  }

  it('marks each sub-action with the kind it asked for, and leaves the rest bare', () => {
    const html = renderReport(reportWith([
      { index: 1, action: act({ action: 'click', selector: '#go' }), durationMs: 1, highlighted: 'act' },
      { index: 2, action: act({ action: 'read', selector: '#note', as: 'n' }), durationMs: 1, highlighted: 'read' },
      { index: 3, action: act({ action: 'navigate', value: 'about:blank' }), durationMs: 1 },
    ]));
    const tags = [...html.matchAll(/<div class="sub-action"[^>]*>/g)].map((m) => m[0]);
    expect(tags).toEqual([
      '<div class="sub-action" data-highlighted="act">',
      '<div class="sub-action" data-highlighted="read">',
      '<div class="sub-action">',
    ]);
  });
});

// ── Review round 1 ───────────────────────────────────────────────────────────

/** Run `body` in the page with the registry handle and its host in scope. */
async function registry<T>(page: Page, body: string): Promise<T> {
  return page.evaluate(({ tag, key, src }) => {
    const host = document.documentElement.querySelector(`:scope > ${tag}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = host ? (host as any)[Symbol.for(key)] : null;
    // eslint-disable-next-line no-new-func
    return new Function('handle', 'host', src)(handle, host);
  }, { tag: HIGHLIGHT_TAG, key: HIGHLIGHT_REGISTRY_KEY, src: body }) as Promise<T>;
}

const hostVisibility = (page: Page): Promise<string | null> =>
  registry<string | null>(page, 'return host ? getComputedStyle(host).visibility : null;');

const waitForRings = (page: Page, count: number): Promise<unknown> =>
  page.waitForFunction(({ tag, key, n }) => {
    const host = document.documentElement.querySelector(`:scope > ${tag}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return host !== null && (host as any)[Symbol.for(key)].rings().length === n;
  }, { tag: HIGHLIGHT_TAG, key: HIGHLIGHT_REGISTRY_KEY, n: count });

/** A far-future clock: "drawn recently" stays true however loaded the machine. */
const FOREVER = { now: () => 8.64e15 };

const appendLate = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'late';
    b.textContent = 'Late';
    document.getElementById('slot')!.appendChild(b);
  });

describe('overlapping hides (review round 1, finding 2)', () => {
  it('counts hides: the rings show again only when every hide has been restored', async () => {
    const page = await pageWith('<button id="go">Go</button>');
    try {
      createHighlighter(STATIC, FOREVER).mark(page.locator('#go'), 'act');
      await waitForRings(page, 1);
      await registry(page, 'handle.hide(); handle.hide(); handle.restore();');
      expect(await hostVisibility(page)).toBe('hidden');
      await registry(page, 'handle.restore();');
      expect(await hostVisibility(page)).toBe('visible');
    } finally {
      await page.close();
    }
  });

  it('a host rebuilt while a capture holds the rings hidden starts hidden', async () => {
    const page = await pageWith('<button id="go">Go</button><button id="item">Item</button>');
    try {
      const highlighter = createHighlighter(STATIC, FOREVER);
      highlighter.mark(page.locator('#go'), 'act');
      await waitForRings(page, 1);
      const seen = await hiddenFor(page, async () => {
        // The last ring ends mid-capture, taking its host with it, and a new
        // mark builds another host before the capture is done.
        await registry(page, 'return handle.finishAll();');
        highlighter.mark(page.locator('#item'), 'act');
        await waitForRings(page, 1);
        return hostVisibility(page);
      }, FOREVER);
      expect(seen).toBe('hidden');
      expect(await hostVisibility(page)).toBe('visible');
    } finally {
      await page.close();
    }
  });

  it('a hide that finds no host still holds a host drawn during the capture hidden', async () => {
    const page = await pageWith('<button id="go">Go</button>');
    try {
      const highlighter = createHighlighter(STATIC, FOREVER);
      highlighter.mark(page.locator('#go'), 'act');
      await waitForRings(page, 1);
      await registry(page, 'return handle.finishAll();');
      // No host now, and the page still reads as drawn recently.
      const seen = await hiddenFor(page, async () => {
        highlighter.mark(page.locator('#go'), 'act');
        await waitForRings(page, 1);
        return hostVisibility(page);
      }, FOREVER);
      expect(seen).toBe('hidden');
      expect(await hostVisibility(page)).toBe('visible');
    } finally {
      await page.close();
    }
  });
});

describe('an element that appears during the act (review round 1, finding 5)', () => {
  it('is ringed once it is attached, after the mark found nothing', async () => {
    const page = await pageWith('<div id="slot"></div>');
    try {
      // An act still waiting for its element: the window in which a late
      // element is the act's (MarkOptions.settled; review round 2, item B).
      createHighlighter(STATIC, FOREVER).mark(page.locator('#late'), 'act', undefined, { settled: new Promise<boolean>(() => {}) });
      // Evaluations run in order, so the mark's first draw, which found
      // nothing, has landed by the time this one answers.
      await page.evaluate(() => 0);
      expect(await registry(page, 'return handle ? handle.rings().length : 0;')).toBe(0);
      await appendLate(page);
      await waitForRings(page, 1);
    } finally {
      await page.close();
    }
  });

  it('through executeAction: the click waits for the element, and the ring follows it', async () => {
    const page = await pageWith('<div id="slot"></div>');
    try {
      const clicked = executeAction(
        page,
        act({ action: 'click', selector: '#late' }),
        undefined,
        undefined,
        { highlight: createHighlighter(STATIC, FOREVER) },
      );
      await page.evaluate(() => 0);
      await appendLate(page);
      expect((await clicked).success).toBe(true);
      await waitForRings(page, 1);
    } finally {
      await page.close();
    }
  });

  it('through the code-behind page wrapper', async () => {
    const raw = await pageWith('<div id="slot"></div>');
    try {
      const page = highlightingPage(raw, createHighlighter(STATIC, FOREVER));
      const clicked = page.locator('#late').click();
      await raw.evaluate(() => 0);
      await appendLate(raw);
      await clicked;
      await waitForRings(raw, 1);
    } finally {
      await raw.close();
    }
  });
});

describe('drawn recently runs from when the ring lands (review round 1, finding 7)', () => {
  it('a ring that lands late is still hidden after the first stamp would have expired', async () => {
    const page = await pageWith('<div id="slot"></div>');
    try {
      let clock = 1_000;
      const highlighter = createHighlighter(STATIC, { now: () => clock });
      // An act still waiting for its element: the window in which a late
      // element is the act's (MarkOptions.settled; review round 2, item B).
      highlighter.mark(page.locator('#late'), 'act', undefined, { settled: new Promise<boolean>(() => {}) });
      await page.evaluate(() => 0);
      // Most of the ring's life passes before its element arrives.
      clock = 1_000 + STATIC.durationMs;
      await appendLate(page);
      await waitForRings(page, 1);
      // Past the first stamp's end, within the late draw's.
      clock = 1_000 + 2 * STATIC.durationMs;
      const seen = await highlighter.hiddenFor(page, () => hostVisibility(page));
      expect(seen).toBe('hidden');
    } finally {
      await page.close();
    }
  });
});

describe('the run decides who its pictures are for (review round 1, finding 6)', () => {
  it('a run whose pictures go to a model hides a ring another caller drew to be shown', async () => {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(SHOT_PAGE);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      // A login drew this ring for a person to see: inScreenshots is true.
      createHighlighter(STATIC, FOREVER).mark(page.locator('#go'), 'act');
      await waitForRings(page, 1);
      expect(near(await ringPixel((await captureScreenshot(page))?.base64), RING)).toBe(true);
      // A screenshotsToModel batch that has drawn nothing, its highlight off.
      const batch = ringsOutOfScreenshots({ highlight: false });
      const shot = await captureScreenshot(page, false, reportAudience(batch));
      expect(near(await ringPixel(shot?.base64), BACKGROUND)).toBe(true);
    } finally {
      await page.close();
    }
  });
});

describe('the page wrapper, again (review round 1, finding 16)', () => {
  it('keeps constructor, and never wraps its own proxy', async () => {
    const raw = await pageWith('<button id="go">Go</button>');
    try {
      const marks: string[] = [];
      const sink: HighlightSink = { mark: (_l, kind) => { marks.push(kind); } };
      const page = highlightingPage(raw, sink);
      const locator = page.locator('#go');
      expect(locator.constructor.name).toBe('Locator');
      expect(page.constructor).toBe(raw.constructor);
      // Handing a proxy back in returns the same proxy, not one around it.
      expect(highlightingPage(page, sink)).toBe(page);
      await locator.click();
      expect(marks).toEqual(['act']);
    } finally {
      await raw.close();
    }
  });
});

// ── Review round 2 ───────────────────────────────────────────────────────────

/** Poll until no late-ring wait is pending: a condition with a ceiling, never
 *  a sleep. */
async function lateWaitsEnded(): Promise<void> {
  await expect.poll(() => lateRingWaitsPending(), { timeout: 10_000 }).toBe(0);
}

describe('a late ring belongs to its act (review round 2, item B)', () => {
  it('a keyboard action with nothing focused waits for nothing, so a later focus is never ringed', async () => {
    const page = await pageWith('<p>text</p><input id="next">');
    try {
      const result = await executeAction(
        page,
        act({ action: 'keyboard', key: 'Escape' }),
        undefined,
        undefined,
        { highlight: createHighlighter(STATIC, FOREVER) },
      );
      expect(result.success).toBe(true);
      expect(lateRingWaitsPending()).toBe(0);
      await page.focus('#next');
      await page.evaluate(() => 0);
      expect(await registry(page, 'return handle ? handle.rings().length : 0;')).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('a mark whose act failed stops waiting, and the next page\'s match is never ringed', async () => {
    const page = await pageWith('<p>page one</p>');
    try {
      const result = await executeAction(
        page,
        act({ action: 'hover', selector: '#late', timeout: 500 } as Partial<AIAction> as AIAction),
        undefined,
        undefined,
        { highlight: createHighlighter(STATIC, FOREVER) },
      );
      expect(result.success).toBe(false);
      await lateWaitsEnded();
      await page.setContent('<p>page two</p><button id="late">On page two</button>');
      await page.evaluate(() => 0);
      expect(await registry(page, 'return handle ? handle.rings().length : 0;')).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('a navigation ends a wait the act is still in', async () => {
    const page = await pageWith('<p>page one</p>');
    try {
      // An act that has not settled: the settle promise is never resolved.
      createHighlighter(STATIC, FOREVER).mark(page.locator('#late'), 'act', undefined, {
        settled: new Promise<boolean>(() => {}),
      });
      await expect.poll(() => lateRingWaitsPending()).toBe(1);
      await page.goto('data:text/html,<p>page two</p><button id="late">On page two</button>');
      await lateWaitsEnded();
      expect(await registry(page, 'return handle ? handle.rings().length : 0;')).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('code-behind: an optional banner that is not there is not ringed when it turns up later', async () => {
    const raw = await pageWith('<div id="slot"></div>');
    try {
      const page = highlightingPage(raw, createHighlighter(STATIC, FOREVER));
      // The pattern generated code uses for something that may not appear.
      try {
        await page.locator('#late').click({ timeout: 300 });
      } catch {
        // Not there: carry on.
      }
      await lateWaitsEnded();
      await appendLate(raw);
      await raw.evaluate(() => 0);
      expect(await registry(raw, 'return handle ? handle.rings().length : 0;')).toBe(0);
    } finally {
      await raw.close();
    }
  });
});

describe('a page cannot stall a capture or be handed the targets (review round 2, item C)', () => {
  /** A page's own host, forging the handle: every method records its call and
   *  the hide never returns. */
  const FORGED = `<script>
    window.__called = [];
    const fake = document.createElement('steptix-highlight');
    fake[Symbol.for('${HIGHLIGHT_REGISTRY_KEY}')] = {
      mark(elements) { window.__called.push('mark:' + elements.length); return 1; },
      rings() { return []; },
      hide() { window.__called.push('hide'); return new Promise(() => {}); },
      restore() { window.__called.push('restore'); return new Promise(() => {}); },
      finishAll() { window.__called.push('finishAll'); return new Promise(() => {}); },
    };
    document.documentElement.appendChild(fake);
  </script><button id="go">Go</button>`;

  it('hide, restore and end never call the page\'s functions', async () => {
    const page = await pageWith(FORGED);
    try {
      expect(await hiddenFor(page, async () => 'shot', { force: true })).toBe('shot');
      await endRings([page], FOREVER);
      createHighlighter(STATIC, FOREVER).mark(page.locator('#go'), 'act');
      await endRings([page], FOREVER);
      expect(await page.evaluate(() => (window as unknown as { __called: string[] }).__called)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('a draw passes over a forged host and builds its own, without handing it the targets', async () => {
    const page = await pageWith(FORGED);
    try {
      expect(await drawRings(page.locator('#go'), 'act', STATIC)).toBe(1);
      expect(await page.evaluate(() => (window as unknown as { __called: string[] }).__called)).toEqual([]);
      expect(await page.evaluate((tag) => document.documentElement.querySelectorAll(`:scope > ${tag}`).length, HIGHLIGHT_TAG))
        .toBe(2);
    } finally {
      await page.close();
    }
  });

  it('a hide whose restore never lands lapses on its own', async () => {
    const page = await pageWith('<button id="go">Go</button>');
    try {
      await drawRings(page.locator('#go'), 'act', STATIC);
      await registry(page, 'handle.hide();');
      expect(await hostVisibility(page)).toBe('hidden');
      // The entry's time runs out, as one whose restore was lost would.
      await page.evaluate((key) => {
        const entries = (document.documentElement as unknown as Record<symbol, Record<string, number>>)[Symbol.for(`${key}.hidden`)]!;
        for (const token of Object.keys(entries)) entries[token] = 0;
      }, HIGHLIGHT_REGISTRY_KEY);
      // The ring's own frame loop notices on its next frame: a condition.
      await page.waitForFunction((tag) => {
        const host = document.documentElement.querySelector(`:scope > ${tag}`);
        return host !== null && getComputedStyle(host).visibility === 'visible';
      }, HIGHLIGHT_TAG);
    } finally {
      await page.close();
    }
  });
});

describe('max counts rings drawn (review round 2, item G)', () => {
  it('a read of every match whose first twenty are hidden still rings the visible ones', async () => {
    const hidden = Array.from({ length: 25 }, (_, i) => `<p class="row" style="display:none">h${i}</p>`).join('');
    const page = await pageWith(`${hidden}<p class="row">v1</p><p class="row">v2</p><p class="row">v3</p>`);
    try {
      expect(await drawRings(page.locator('.row'), 'read', STATIC, 20)).toBe(3);
      const many = Array.from({ length: 30 }, (_, i) => `<p class="item">${i}</p>`).join('');
      await page.setContent(many);
      expect(await drawRings(page.locator('.item'), 'read', STATIC, 20)).toBe(20);
    } finally {
      await page.close();
    }
  });
});

describe('the DOM snapshot skips only Steptix\'s own host (review round 2, item F)', () => {
  it('keeps a page\'s own <steptix-highlight>, nested or at the top', async () => {
    const page = await pageWith('<p>Before</p><steptix-highlight><button id="pay">Pay now</button></steptix-highlight><p>After</p>');
    try {
      await page.evaluate(() => {
        const top = document.createElement('steptix-highlight');
        top.textContent = 'A page element beside body';
        document.documentElement.appendChild(top);
      });
      const snapshot = await captureDomSnapshot(page);
      expect(snapshot).toContain('Pay now');
      expect(snapshot).toContain('A page element beside body');
      // And Steptix's own host is still left out.
      await drawRings(page.locator('#pay'), 'act', STATIC);
      const withRing = await captureDomSnapshot(page);
      expect(withRing).toBe(snapshot);
    } finally {
      await page.close();
    }
  });
});

// ── Review round 3 ───────────────────────────────────────────────────────────

describe('which navigation ends a late wait (review round 3, item 3)', () => {
  it('an ad frame rotating does not; the ring still follows the late element', async () => {
    const page = await browser.newPage();
    try {
      await page.route('http://main.test/', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<div id="slot"></div><iframe id="ad" src="http://ad.test/1"></iframe>' }));
      await page.route('http://ad.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>ad</p>' }));
      await page.goto('http://main.test/');
      createHighlighter(STATIC, FOREVER).mark(page.locator('#late'), 'act', undefined, {
        settled: new Promise<boolean>(() => {}),
      });
      await expect.poll(() => lateRingWaitsPending()).toBe(1);
      const adFrame = page.frames().find((frame) => frame !== page.mainFrame())!;
      const rotated = page.waitForEvent('framenavigated', (frame) => frame === adFrame);
      await page.evaluate(() => {
        (document.getElementById('ad') as HTMLIFrameElement).src = 'http://ad.test/2';
      });
      await rotated;
      expect(lateRingWaitsPending()).toBe(1);
      await appendLate(page);
      await waitForRings(page, 1);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.close();
    }
  });
});

describe('[use computer] ends pending late rings too (review round 3, item 4)', () => {
  it('endRings cancels a wait that would otherwise draw after it', async () => {
    const page = await pageWith('<div id="slot"></div>');
    try {
      createHighlighter(STATIC, FOREVER).mark(page.locator('#late'), 'act', undefined, {
        settled: new Promise<boolean>(() => {}),
      });
      await expect.poll(() => lateRingWaitsPending()).toBe(1);
      await endRings([page], FOREVER);
      expect(lateRingWaitsPending()).toBe(0);
      await appendLate(page);
      await page.evaluate(() => 0);
      expect(await registry(page, 'return handle ? handle.rings().length : 0;')).toBe(0);
    } finally {
      await page.close();
    }
  });
});

// ── Review round 4 ───────────────────────────────────────────────────────────

describe('a late wait inside a frame (review round 4, item 4)', () => {
  it('Playwright still names a locator\'s frame and its frame entry where the guard reads them', async () => {
    const page = await pageWith('<iframe id="f" srcdoc="<p>x</p>"></iframe>');
    try {
      expect(frameOfLocator(page.locator('#late'))).toEqual({ frame: page.mainFrame(), entersFrame: false });
      expect(frameOfLocator(page.frameLocator('#f').locator('#late'))).toEqual({ frame: page.mainFrame(), entersFrame: true });
    } finally {
      await page.close();
    }
  });

  it('the element\'s own iframe navigating ends the wait', async () => {
    const page = await browser.newPage();
    try {
      await page.route('http://main.test/', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<iframe id="f" src="http://pay.test/1"></iframe>' }));
      await page.route('http://pay.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>pay</p>' }));
      await page.goto('http://main.test/');
      createHighlighter(STATIC, FOREVER).mark(page.frameLocator('#f').locator('#late'), 'act', undefined, {
        settled: new Promise<boolean>(() => {}),
      });
      await expect.poll(() => lateRingWaitsPending()).toBe(1);
      await page.evaluate(() => {
        (document.getElementById('f') as HTMLIFrameElement).src = 'http://pay.test/2';
      });
      await lateWaitsEnded();
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.close();
    }
  });
});

// ── Review round 5 ───────────────────────────────────────────────────────────

/** Wait until `page` shows `n` rings of ours. */
const ringsShown = (page: Page, n: number): Promise<void> =>
  expect.poll(() => registry<number>(page, 'return handle ? handle.rings().length : 0;')).toBe(n);

/** Count `context.newCDPSession` calls from here on. */
function countSessions(context: import('playwright').BrowserContext): { count: number } {
  const counter = { count: 0 };
  const original = context.newCDPSession.bind(context);
  context.newCDPSession = ((target: Page) => {
    counter.count++;
    return original(target);
  }) as typeof context.newCDPSession;
  return counter;
}

describe('the frame that drew is known by its Frame, not its address (review round 5, item 1)', () => {
  const moves = [
    ['pushState', () => history.pushState({}, '', '/checkout')],
    ['a hash change', () => {
      location.hash = '#paid';
    }],
  ] as const;
  for (const [name, move] of moves) {
    it(`after ${name}, the first capture past the lifetime confirms the frame, and the next asks nothing`, async () => {
      const page = await browser.newPage();
      try {
        await page.route('http://app.test/**', (route) =>
          route.fulfill({ contentType: 'text/html', body: '<button id="go">Go</button>' }));
        await page.goto('http://app.test/');
        let clock = 1_000;
        const highlighter = createHighlighter(STATIC, { now: () => clock });
        highlighter.mark(page.locator('#go'), 'act');
        await ringsShown(page, 1);
        await page.evaluate(move);
        expect(page.url()).not.toBe('http://app.test/');
        // The ring retires (its host goes with it): only the frame's own
        // answer that no host is left clears its entry (§16.10).
        await registry(page, 'return handle ? handle.finishAll() : null;');
        clock += 2 * STATIC.durationMs;
        const spies = page.frames().map((frame) => vi.spyOn(frame, 'evaluate'));
        try {
          expect(await highlighter.hiddenFor(page, async () => 'shot')).toBe('shot');
          expect(spies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
          for (const spy of spies) spy.mockClear();
          // An address-keyed record was orphaned here: nothing could ever
          // match it again, so every later capture asked.
          expect(await highlighter.hiddenFor(page, async () => 'shot')).toBe('shot');
          for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        } finally {
          for (const spy of spies) spy.mockRestore();
        }
      } finally {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.close();
      }
    });
  }
});

describe('records that can say nothing are pruned (review round 5, item 2)', () => {
  it('a tab closed within its ring\'s lifetime leaves nothing for a highlight-off page to pay', async () => {
    const drew = await browser.newContext();
    const off = await browser.newContext();
    try {
      let clock = 1_000;
      const page = await drew.newPage();
      await page.setContent('<button id="go">Go</button>');
      createHighlighter(STATIC, { now: () => clock }).mark(page.locator('#go'), 'act');
      await ringsShown(page, 1);
      // A capture within the lifetime: it waits for the tab's record to be
      // written, and confirms nothing.
      expect(await hiddenFor(page, async () => 'shot', { now: () => clock })).toBe('shot');
      await page.close();
      clock += 2 * STATIC.durationMs;

      const sessions = countSessions(off);
      const other = await off.newPage();
      await other.setContent('<p>off</p><iframe srcdoc="<p>ad</p>"></iframe>');
      const spies = other.frames().map((frame) => vi.spyOn(frame, 'evaluate'));
      expect(await hiddenFor(other, async () => 'shot', { now: () => clock })).toBe('shot');
      expect(sessions.count).toBe(0);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      await drew.close();
      await off.close();
    }
  });

  it('a page that drew and is then left alone clears its own record, so a highlight-off page pays nothing', async () => {
    const drew = await browser.newContext();
    const off = await browser.newContext();
    try {
      const page = await drew.newPage();
      await page.setContent('<button id="go">Go</button>');
      // The real clock and a short ring: what the test waits on below is the
      // condition, never a time.
      createHighlighter({ ...STATIC, durationMs: 50 }).mark(page.locator('#go'), 'act');
      await page.evaluate(() => history.pushState({}, '', '#/next'));
      // No capture of `page` from here on: nothing but the page's own
      // confirmation after its ring can clear the record.
      const sessions = countSessions(off);
      await vi.waitFor(async () => {
        const other = await off.newPage();
        try {
          const before = sessions.count;
          const spies = other.frames().map((frame) => vi.spyOn(frame, 'evaluate'));
          expect(await hiddenFor(other, async () => 'shot')).toBe('shot');
          expect(sessions.count - before).toBe(0);
          for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        } finally {
          await other.close();
        }
      }, { timeout: 20_000, interval: 100 });
    } finally {
      await drew.close();
      await off.close();
    }
  });
});

// ── Review round 6 ───────────────────────────────────────────────────────────

describe('a ring that starts after its frame unblocks (review round 6, H1)', () => {
  it('stays hidden from every model capture until the frame says its host is gone, whatever our clock says', async () => {
    // The page blocks its main thread as soon as our host appears, before the
    // ring's first paint: the ring's animation starts when it unblocks, so it
    // is on screen after its lifetime on our clock. The clock below is moved
    // past that lifetime to stand for it; the page's ring is still live.
    const page = await browser.newPage({ viewport: { width: 400, height: 300 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(SHOT_PAGE);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate((tag) => {
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.nodeType === 1 && (node as Element).tagName.toLowerCase() === tag) {
                setTimeout(() => {
                  const end = Date.now() + 300;
                  while (Date.now() < end) { /* blocked before the first paint */ }
                }, 0);
              }
            }
          }
        }).observe(document.documentElement, { childList: true });
      }, HIGHLIGHT_TAG);
      let clock = 1_000;
      const highlighter = createHighlighter(STATIC, { now: () => clock });
      highlighter.mark(page.locator('#go'), 'act');
      await ringsShown(page, 1);
      await page.evaluate(() => 0); // the draw's answer has reached Node
      clock += 2 * STATIC.durationMs;

      const spies = page.frames().map((frame) => vi.spyOn(frame, 'evaluate'));
      try {
        for (const name of ['first', 'second']) {
          for (const spy of spies) spy.mockClear();
          const shot = await highlighter.hiddenFor(page, () => captureScreenshot(page));
          expect(near(await ringPixel(shot?.base64), BACKGROUND), `${name} capture shows no ring`).toBe(true);
          expect(spies.some((spy) => spy.mock.calls.length > 0), `${name} capture asked the frame`).toBe(true);
        }
        // The ring is really there for the person watching.
        expect(near(await ringPixel((await captureScreenshot(page))?.base64), RING)).toBe(true);
        // Its retire takes the host away: one capture hears so, the next asks
        // nothing.
        await registry(page, 'return handle ? handle.finishAll() : null;');
        await highlighter.hiddenFor(page, () => captureScreenshot(page));
        for (const spy of spies) spy.mockClear();
        await highlighter.hiddenFor(page, () => captureScreenshot(page));
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    } finally {
      await page.close();
    }
  });
});

describe('a page that ever drew stays known for the diagnosis fallback (audit, item 2)', () => {
  it('is still "ever ringed" after endRings and after it closes; a page never marked is not', async () => {
    // diagnoseFailure sends the step's report picture only for a page that
    // never had a ring: a report picture may show one.
    const page = await pageWith('<button id="go">Go</button>');
    const never = await pageWith('<p>never ringed</p>');
    try {
      createHighlighter(STATIC, FOREVER).mark(page.locator('#go'), 'act');
      await ringsShown(page, 1);
      expect(pageEverRinged(page)).toBe(true);
      await endRings([page], FOREVER);
      expect(pageEverRinged(page)).toBe(true);
      await page.close();
      expect(pageEverRinged(page)).toBe(true);
      expect(pageEverRinged(never)).toBe(false);
    } finally {
      if (!page.isClosed()) await page.close();
      await never.close();
    }
  });
});

describe('a session that ends mid-ring leaves nothing for highlight-off pages to pay (review 14, items 2 and 3)', () => {
  // Each teardown here closes the tab: the record goes at once. Only a CDP
  // disconnect that leaves the tab open keeps it (tests/highlight-cdp-tab.test.ts).
  const modes: Array<[string, () => Promise<{ page: Page; teardown: () => Promise<void> }>]> = [
    ['page.close()', async () => {
      const page = await browser.newPage();
      return { page, teardown: () => page.close() };
    }],
    ['closeBrowser on a launched session (context, then browser)', async () => {
      const own = await chromium.launch({ headless: true });
      const context = await own.newContext();
      const page = await context.newPage();
      const session = { browser: own, context, page } as unknown as BrowserSession;
      return { page, teardown: () => closeBrowser(session) };
    }],
    ['browser.close() on a launched browser', async () => {
      const own = await chromium.launch({ headless: true });
      const page = await own.newPage();
      return { page, teardown: () => own.close() };
    }],
    ['close() on a persistent context', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-highlight-persistent-'));
      const context = await chromium.launchPersistentContext(dir, { headless: true });
      const page = context.pages()[0] ?? (await context.newPage());
      return {
        page,
        teardown: async () => {
          await context.close();
          await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
        },
      };
    }],
  ];
  for (const [name, open] of modes) {
    it(`after ${name}`, async () => {
      const { page, teardown } = await open();
      let clock = 1_000;
      await page.setContent('<button id="go">Go</button>');
      createHighlighter(STATIC, { now: () => clock }).mark(page.locator('#go'), 'act');
      await ringsShown(page, 1);
      // A capture within the lifetime: the tab's record is written, and the
      // ring is still up when the session ends.
      expect(await hiddenFor(page, async () => 'shot', { now: () => clock })).toBe('shot');
      await teardown();
      clock += 2 * STATIC.durationMs;

      const off = await browser.newContext();
      try {
        const sessions = countSessions(off);
        const other = await off.newPage();
        await other.setContent('<p>off</p>');
        const spies = other.frames().map((frame) => vi.spyOn(frame, 'evaluate'));
        expect(await hiddenFor(other, async () => 'shot', { now: () => clock })).toBe('shot');
        expect(sessions.count).toBe(0);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        await off.close();
      }
    });
  }
});

// ── Review 23 ────────────────────────────────────────────────────────────────

describe('a javascript: frame the page fills itself (review 23, item 1)', () => {
  it('is hidden from a model capture, though Playwright reports no address for it', async () => {
    // An ad pattern: <iframe src="javascript:false"> whose document the
    // parent writes. It has a live document in the page's process, yet its
    // url() reads ''.
    const page = await browser.newPage();
    try {
      await page.setContent('<iframe id="js" src="javascript:false"></iframe>'
        + '<script>setTimeout(() => { document.getElementById("js").contentDocument.body.innerHTML = '
        + '\'<button id="jb">Go</button>\'; }, 0);</script>');
      await page.frameLocator('#js').locator('#jb').waitFor();
      const js = page.frames().find((frame) => frame !== page.mainFrame())!;
      expect(js.url()).toBe('');
      const inFrame = (): Promise<string | null> => page.evaluate((tag) => {
        const doc = (document.getElementById('js') as HTMLIFrameElement).contentDocument;
        const host = doc?.documentElement.querySelector(`:scope > ${tag}`);
        return host ? getComputedStyle(host).visibility : null;
      }, HIGHLIGHT_TAG);
      createHighlighter(STATIC, FOREVER).mark(page.frameLocator('#js').locator('#jb'), 'act');
      await expect.poll(inFrame).toBe('visible');
      expect(await hiddenFor(page, inFrame, FOREVER)).toBe('hidden');
      expect(await inFrame()).toBe('visible');
    } finally {
      await page.close();
    }
  });
});

describe('a frame asked through its parent is judged on its own clock (review 26, item 1)', () => {
  // A javascript: frame is asked through its <iframe> element, so the hide
  // runs in the PARENT's realm. The frame's ring controller stamps its
  // animation frames and lapses hide entries on the frame's own Date.now; a
  // parent that shifts its Date.now (a page correcting for server time) must
  // not make the hide skip its paint wait (ahead) or write an entry the
  // controller takes as already lapsed (behind).
  it.each([5_000, -70_000])('with the parent\'s Date.now %i ms off, the hide waits for the paint and the host stays hidden', async (skew) => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<script>(() => { const own = Date.now; Date.now = () => own() + ${skew}; })();</script>`
        + '<iframe id="js" src="javascript:false"></iframe>'
        + '<script>setTimeout(() => { document.getElementById("js").contentDocument.body.innerHTML = '
        + '\'<button id="jb">Go</button>\'; }, 0);</script>');
      await page.frameLocator('#js').locator('#jb').waitFor();
      expect(page.frames().find((frame) => frame !== page.mainFrame())!.url()).toBe('');
      createHighlighter(STATIC, FOREVER).mark(page.frameLocator('#js').locator('#jb'), 'act');
      // The frame is being drawn: its controller's last animation frame is
      // recent on the frame's own clock.
      await expect.poll(() => page.evaluate((key) => {
        const w = (document.getElementById('js') as HTMLIFrameElement).contentWindow as unknown as Window & typeof globalThis;
        const at = (w.document.documentElement as unknown as Record<symbol, unknown>)[Symbol.for(`${key}.tick`)];
        return typeof at === 'number' && w.Date.now() - at <= 50;
      }, HIGHLIGHT_REGISTRY_KEY)).toBe(true);
      // Count the frame's setTimeout calls: its controller makes none, the
      // hide's paint wait makes one.
      await page.evaluate(() => {
        const w = (document.getElementById('js') as HTMLIFrameElement).contentWindow as unknown as { timers_: number; setTimeout: typeof setTimeout };
        const native = w.setTimeout;
        w.timers_ = 0;
        w.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
          w.timers_++;
          return native.apply(w, args);
        }) as typeof setTimeout;
      });
      // Inside the capture, one animation frame of the frame's own later: its
      // controller has run its tick, re-applying the hidden state from the
      // entries on its own clock.
      const seen = await hiddenFor(page, () => page.evaluate((tag) => new Promise<string | null>((resolve) => {
        const w = (document.getElementById('js') as HTMLIFrameElement).contentWindow!;
        w.requestAnimationFrame(() => {
          const host = w.document.documentElement.querySelector(`:scope > ${tag}`);
          resolve(host ? w.getComputedStyle(host).visibility : null);
        });
      }), HIGHLIGHT_TAG), FOREVER);
      expect(await page.evaluate(() =>
        ((document.getElementById('js') as HTMLIFrameElement).contentWindow as unknown as { timers_: number }).timers_))
        .toBeGreaterThanOrEqual(1);
      expect(seen).toBe('hidden');
    } finally {
      await page.close();
    }
  });

  it('in a frame running no animation frames, the hide alone decides, on the frame\'s clock', async () => {
    // As in a frame Chrome is not drawing: no tick re-applies the entries,
    // and no paint wait. The parent's clock runs past the entry's lapse, so a
    // decision on it would leave the host showing.
    const page = await browser.newPage();
    try {
      await page.setContent('<script>(() => { const own = Date.now; Date.now = () => own() + 70000; })();</script>'
        + '<iframe id="js" src="javascript:false"></iframe>'
        + '<script>setTimeout(() => { const w = document.getElementById("js").contentWindow; '
        + 'w.requestAnimationFrame = () => 0; '
        + 'w.document.body.innerHTML = \'<button id="jb">Go</button>\'; }, 0);</script>');
      await page.frameLocator('#js').locator('#jb').waitFor();
      const inFrame = (): Promise<string | null> => page.evaluate((tag) => {
        const doc = (document.getElementById('js') as HTMLIFrameElement).contentDocument;
        const host = doc?.documentElement.querySelector(`:scope > ${tag}`);
        return host ? getComputedStyle(host).visibility : null;
      }, HIGHLIGHT_TAG);
      createHighlighter(STATIC, FOREVER).mark(page.frameLocator('#js').locator('#jb'), 'act');
      await expect.poll(inFrame).toBe('visible');
      expect(await hiddenFor(page, inFrame, FOREVER)).toBe('hidden');
    } finally {
      await page.close();
    }
  });
});
