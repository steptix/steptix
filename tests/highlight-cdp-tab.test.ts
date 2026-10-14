/**
 * Two Playwright Page objects on one CDP tab — an errand's attach and a
 * session's — and a ring drawn through one (docs/specs/SPEC-interaction-highlight.md
 * §16.6; review round 3, item 2). "Drawn recently" is per Page object, so
 * the other Page's model capture used to show the ring. Now each connection
 * is registered with its endpoint, as connectOverCdpSession registers it, and
 * while a ring's tab record lives every Page on that tab finds it, by endpoint
 * and CDP target id, and hides (§4.3 rules 9 and 10).
 *
 * Its own file because the tab records are module state; vitest gives each
 * file a fresh module.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  HIGHLIGHT_DEFAULTS,
  HIGHLIGHT_REGISTRY_KEY,
  HIGHLIGHT_TAG,
  createHighlighter,
  drawRings,
  endRings,
  hiddenFor,
  registerCdpBrowser,
  resetRingRecordsForTests,
} from '../src/browser/highlight.js';
import { closeBrowser, type BrowserSession } from '../src/browser/manager.js';
import { listenFetchable } from './listen-fetchable.cjs';
import Jimp from 'jimp';

let dir: string;
let owner: BrowserContext;
let viaA: Browser;
let viaB: Browser;
let pageA: Page;
let pageB: Page;

/** The tab's host visibility, read through `page`. */
const visibility = (page: Page): Promise<string | null> =>
  page.evaluate((tag) => {
    const host = document.documentElement.querySelector(`:scope > ${tag}`);
    return host ? getComputedStyle(host).visibility : null;
  }, HIGHLIGHT_TAG);

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-highlight-cdp-'));
  owner = await chromium.launchPersistentContext(dir, { headless: true, args: ['--remote-debugging-port=0'] });
  const tab = owner.pages()[0] ?? (await owner.newPage());
  await tab.setContent('<button id="go">Go</button>');
  // Chromium writes the port it chose here once it listens: a condition.
  let port = '';
  await vi.waitFor(async () => {
    port = (await fs.readFile(path.join(dir, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0] ?? '';
    if (port === '') throw new Error('no DevToolsActivePort yet');
  }, { timeout: 30_000, interval: 50 });
  viaA = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  viaB = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  // As connectOverCdpSession does: two connections to one browser can hold
  // Pages on one tab.
  registerCdpBrowser(viaA, `127.0.0.1:${port}`);
  registerCdpBrowser(viaB, `127.0.0.1:${port}`);
  const find = (b: Browser): Page => b.contexts().flatMap((c) => c.pages()).find((p) => p.url() === tab.url())!;
  pageA = find(viaA);
  pageB = find(viaB);
}, 120_000);

// Launching, connecting to and closing browsers is what a loaded machine
// slows most: the hooks and the cases that do it have budgets well past the
// default. A budget is how long the run may take, not a check on it.

// "A ring is up somewhere" and the tab records are module state, and every
// case here draws on the same CDP tab: without this, one case's ring would
// still be on record for the next, and a case would pass or fail by order.
beforeEach(() => {
  resetRingRecordsForTests();
});

afterAll(async () => {
  await viaA?.close().catch(() => {});
  await viaB?.close().catch(() => {});
  await owner?.close().catch(() => {});
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
}, 120_000);

describe('one CDP tab, two Page objects', () => {
  it('a ring drawn through one is hidden from a model capture through the other, and ended through it', async () => {
    expect(pageA).not.toBe(pageB);
    createHighlighter({ ...HIGHLIGHT_DEFAULTS, durationMs: 10_000 }, { now: () => 8.64e15 })
      .mark(pageA.locator('#go'), 'act');
    await pageB.waitForFunction(({ tag, key }) => {
      const host = document.documentElement.querySelector(`:scope > ${tag}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return host !== null && (host as any)[Symbol.for(key)].rings().length === 1;
    }, { tag: HIGHLIGHT_TAG, key: HIGHLIGHT_REGISTRY_KEY });

    // pageB has no record of its own; the process-wide one is what hides.
    expect(await hiddenFor(pageB, () => visibility(pageB), { now: () => 8.64e15 })).toBe('hidden');
    expect(await visibility(pageB)).toBe('visible');

    await endRings([pageB], { now: () => 8.64e15 });
    expect(await visibility(pageA)).toBeNull();
  });
});

describe('a ring in one browser does not reach another (review round 4, item 2)', () => {
  it('a page in another browser, never ringed, is photographed with no round trip to its frames', async () => {
    const other = await chromium.launch({ headless: true });
    try {
      const page = await other.newPage();
      await page.setContent('<p>shop</p><iframe srcdoc="<p>ad</p>"></iframe>');
      // A ring of ours elsewhere in the process — in the CDP tab's browser.
      createHighlighter({ ...HIGHLIGHT_DEFAULTS, durationMs: 10_000 }, { now: () => 8.64e15 })
        .mark(pageA.locator('#go'), 'act');
      const spies = page.frames().map((frame) => vi.spyOn(frame, 'evaluate'));
      expect(await hiddenFor(page, async () => 'shot', { now: () => 8.64e15 })).toBe('shot');
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      await other.close();
    }
  }, 90_000);
});

describe('another Page on the tab holds every frame until they answer (review round 5, item 1)', () => {
  it('after pushState, past the ring\'s lifetime the first capture through it asks every frame, and once they have answered, the next asks none', async () => {
    // Past every clock the cases above drew on.
    let clock = 8.7e15;
    createHighlighter({ ...HIGHLIGHT_DEFAULTS, durationMs: 10_000 }, { now: () => clock })
      .mark(pageA.locator('#go'), 'act');
    await pageB.waitForFunction(({ tag, key }) => {
      const host = document.documentElement.querySelector(`:scope > ${tag}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return host !== null && (host as any)[Symbol.for(key)].rings().length >= 1;
    }, { tag: HIGHLIGHT_TAG, key: HIGHLIGHT_REGISTRY_KEY });
    // pageA's connection has delivered the draw's answer once this returns.
    await pageA.evaluate(() => 0);
    // An SPA router moves the address on: no address the draw answered with
    // matches any frame now.
    const before = pageB.url();
    await pageA.evaluate(() => history.pushState({}, '', '#/moved'));
    await expect.poll(() => pageB.url()).not.toBe(before);
    // The ring retires, its host with it: what lets a frame's entry go is the
    // frame answering that no host is left (§16.10), not the clock.
    await pageB.evaluate(({ tag, key }) => {
      const host = document.documentElement.querySelector(`:scope > ${tag}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return host ? (host as any)[Symbol.for(key)].finishAll() : null;
    }, { tag: HIGHLIGHT_TAG, key: HIGHLIGHT_REGISTRY_KEY });
    clock += 30_000; // well past the ring's lifetime
    const spies = pageB.frames().map((frame) => vi.spyOn(frame, 'evaluate'));
    try {
      // pageB's Frame objects are not pageA's, so which one drew is unknown
      // here: every frame of the tab is held until it answers.
      expect(await hiddenFor(pageB, async () => 'shot', { now: () => clock })).toBe('shot');
      for (const spy of spies) expect(spy).toHaveBeenCalled();
      for (const spy of spies) spy.mockClear();
      expect(await hiddenFor(pageB, async () => 'shot', { now: () => clock })).toBe('shot');
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('a Page that drew and then went away (audit, item 1)', () => {
  it('leaves its tab\'s record for the other Pages on the tab: their model capture still hides the ring', async () => {
    // An errand attaches to the session's CDP tab, draws, and detaches while
    // its ring is still live. The tab, and the ring, outlive its Page.
    // Detached through closeBrowser, the owner's teardown: a bare
    // browser.close() on the connection is now taken as the tab closing.
    const port = (await fs.readFile(path.join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    const viaC = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    registerCdpBrowser(viaC, `127.0.0.1:${port}`);
    const pageC = viaC.contexts().flatMap((c) => c.pages()).find((p) => p.url() === pageB.url())!;
    // Past every clock the cases above drew on.
    const clock = 9e15;
    createHighlighter({ ...HIGHLIGHT_DEFAULTS, durationMs: 10_000 }, { now: () => clock })
      .mark(pageC.locator('#go'), 'act');
    await pageB.waitForFunction(({ tag, key }) => {
      const host = document.documentElement.querySelector(`:scope > ${tag}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return host !== null && (host as any)[Symbol.for(key)].rings().length >= 1;
    }, { tag: HIGHLIGHT_TAG, key: HIGHLIGHT_REGISTRY_KEY });
    await pageC.evaluate(() => 0); // the draw's answer has reached Node
    // A capture through C in the ring's life: the tab's record is written.
    expect(await hiddenFor(pageC, async () => 'shot', { now: () => clock })).toBe('shot');
    // A capture through B that starts inside C's close event: on a CDP
    // detach that event fires while C's Browser still reports connected, so
    // nothing may be inferred from the connection there (review 14, item 1).
    const raced: Promise<string | null>[] = [];
    pageC.on('close', () => {
      raced.push(hiddenFor(pageB, () => visibility(pageB), { now: () => clock }));
    });
    // The errand's teardown: closeBrowser on an attach that did not open the
    // tab disconnects, and says the tab stays open.
    await closeBrowser({
      cdp: true,
      cdpTabOpenedByUs: false,
      browser: viaC,
      context: viaC.contexts()[0]!,
      page: pageC,
    } as unknown as BrowserSession);
    expect(pageC.isClosed()).toBe(true);
    expect(pageB.isClosed()).toBe(false);
    expect(await Promise.all(raced)).toEqual(['hidden']);

    expect(await hiddenFor(pageB, () => visibility(pageB), { now: () => clock })).toBe('hidden');
    expect(await visibility(pageB)).toBe('visible');
    await endRings([pageB], { now: () => clock });
    expect(await visibility(pageB)).toBeNull();
    // The end found every frame clear: once the ring's lifetime is over, the
    // record left behind is gone, and a capture asks nothing.
    const spies = pageB.frames().map((frame) => vi.spyOn(frame, 'evaluate'));
    try {
      expect(await hiddenFor(pageB, async () => 'shot', { now: () => clock + 30_000 })).toBe('shot');
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }, 90_000);
});

describe('closeBrowser on a CDP attach that opened its own tab (review 14, items 2 and 3)', () => {
  it('closes that tab, and its record goes with it: a highlight-off page pays nothing after', async () => {
    const port = (await fs.readFile(path.join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    const viaD = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    registerCdpBrowser(viaD, `127.0.0.1:${port}`);
    const context = viaD.contexts()[0]!;
    const pageD = await context.newPage();
    await pageD.setContent('<button id="go">Go</button>');
    let clock = 9.1e15; // past every clock the cases above drew on
    createHighlighter({ ...HIGHLIGHT_DEFAULTS, durationMs: 10_000 }, { now: () => clock })
      .mark(pageD.locator('#go'), 'act');
    await pageD.waitForFunction(({ tag, key }) => {
      const host = document.documentElement.querySelector(`:scope > ${tag}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return host !== null && (host as any)[Symbol.for(key)].rings().length >= 1;
    }, { tag: HIGHLIGHT_TAG, key: HIGHLIGHT_REGISTRY_KEY });
    expect(await hiddenFor(pageD, async () => 'shot', { now: () => clock })).toBe('shot');
    await closeBrowser({ cdp: true, cdpTabOpenedByUs: true, browser: viaD, context, page: pageD } as unknown as BrowserSession);
    clock += 30_000;

    const other = await chromium.launch({ headless: true });
    try {
      const offContext = await other.newContext();
      let sessions = 0;
      const original = offContext.newCDPSession.bind(offContext);
      offContext.newCDPSession = ((target: Page) => {
        sessions++;
        return original(target);
      }) as typeof offContext.newCDPSession;
      const page = await offContext.newPage();
      await page.setContent('<p>off</p>');
      const spies = page.frames().map((frame) => vi.spyOn(frame, 'evaluate'));
      expect(await hiddenFor(page, async () => 'shot', { now: () => clock })).toBe('shot');
      expect(sessions).toBe(0);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      await other.close();
    }
  }, 90_000);
});

describe('a cross-site frame that loaded before the attach (review 19, item 1)', () => {
  // Desktop Chrome puts a cross-site iframe in a process of its own. A CDP
  // connection made after it loaded sees its URL as '' until it navigates,
  // yet evaluations reach it: it must be hidden like any other frame.
  let isoDir: string;
  let isoOwner: BrowserContext;
  let server: http.Server;
  let via: Browser | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      const port = (server.address() as { port: number }).port;
      if (req.url?.startsWith('/frame')) {
        res.end('<button id="b" style="margin:20px">Pay</button>');
        return;
      }
      // A cross-site frame; a javascript: frame the page fills itself (an ad
      // pattern, whose address Playwright never reports); and below the
      // fold, a cross-site frame that loads (Chrome draws nothing of it while
      // it is out of view) and a lazy iframe that never loads, with no
      // document of its own.
      res.end('<p>shop</p>'
        + `<iframe id="xs" src="http://localhost:${port}/frame" style="width:300px;height:120px"></iframe>`
        + '<iframe id="js" src="javascript:false" style="width:300px;height:120px"></iframe>'
        + '<script>setTimeout(() => { document.getElementById("js").contentDocument.body.innerHTML = '
        + '\'<button id="jb" style="margin:20px">Go</button>\'; }, 0);</script>'
        + '<div style="height:8000px"></div>'
        + `<iframe id="far" src="http://localhost:${port}/frame?far" style="width:300px;height:120px"></iframe>`
        + '<iframe id="lazy" loading="lazy" src="/frame?lazy"></iframe>');
    });
    const port = await listenFetchable(server, '127.0.0.1');
    isoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-highlight-oopif-'));
    isoOwner = await chromium.launchPersistentContext(isoDir, {
      headless: true,
      args: ['--remote-debugging-port=0', '--site-per-process'],
    });
    const tab = isoOwner.pages()[0] ?? (await isoOwner.newPage());
    await tab.goto(`http://127.0.0.1:${port}/`);
    await tab.frameLocator('#xs').locator('#b').waitFor();
    await tab.frameLocator('#js').locator('#jb').waitFor();
    await tab.frameLocator('#far').locator('#b').waitFor({ state: 'attached' });
  }, 120_000);

  afterAll(async () => {
    await via?.close().catch(() => {});
    await isoOwner?.close().catch(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await fs.rm(isoDir, { recursive: true, force: true, maxRetries: 3 });
  }, 120_000);

  /** The Page attached after load, connected and registered as
   *  connectOverCdpSession does. */
  async function attached(): Promise<Page> {
    if (via === undefined) {
      let devtools = '';
      await vi.waitFor(async () => {
        devtools = (await fs.readFile(path.join(isoDir, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0] ?? '';
        if (devtools === '') throw new Error('no DevToolsActivePort yet');
      }, { timeout: 30_000, interval: 50 });
      via = await chromium.connectOverCDP(`http://127.0.0.1:${devtools}`);
      registerCdpBrowser(via, `127.0.0.1:${devtools}`);
    }
    return via.contexts()[0]!.pages().find((p) => p.url().startsWith('http://127.0.0.1:'))!;
  }

  /** A child frame by its <iframe> element's id: no timing involved. */
  async function childById(page: Page, id: string): Promise<import('playwright').Frame> {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const element = await frame.frameElement();
      if ((await element.getAttribute('id')) === id) return frame;
    }
    throw new Error(`no frame #${id}`);
  }

  /** The host's visibility in a same-origin child's document, read from the parent. */
  const childVisibility = (page: Page, id: string): Promise<string | null> =>
    page.evaluate(({ tag, frameId }) => {
      const doc = (document.getElementById(frameId) as HTMLIFrameElement).contentDocument;
      const host = doc?.documentElement.querySelector(`:scope > ${tag}`);
      return host ? getComputedStyle(host).visibility : null;
    }, { tag: HIGHLIGHT_TAG, frameId: id });

  /**
   * Count a frame's `setTimeout` calls from here on, until `uncountTimers`.
   * The ring controller never calls it, so in a frame with only our ring the
   * calls are the hide's or end's paint wait (two animation frames, or the
   * budget's timer).
   */
  const countTimers = (frame: import('playwright').Frame): Promise<void> =>
    frame.evaluate(() => {
      const w = window as unknown as { timers_: number; native_?: typeof setTimeout; setTimeout: typeof setTimeout };
      w.timers_ = 0;
      if (w.native_ !== undefined) return;
      const native = w.setTimeout;
      w.native_ = native;
      w.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
        w.timers_++;
        return native.apply(window, args);
      }) as typeof setTimeout;
    });
  const timersIn = (frame: import('playwright').Frame): Promise<number> =>
    frame.evaluate(() => (window as unknown as { timers_: number }).timers_);
  const uncountTimers = (frame: import('playwright').Frame): Promise<void> =>
    frame.evaluate(() => {
      const w = window as unknown as { timers_?: number; native_?: typeof setTimeout; setTimeout: typeof setTimeout };
      if (w.native_ !== undefined) w.setTimeout = w.native_;
      delete w.native_;
      delete w.timers_;
    });
  /** How long ago the frame's ring controller last ran an animation frame,
   *  or null if it never has. */
  const sinceDrawn = (frame: import('playwright').Frame): Promise<number | null> =>
    frame.evaluate((key) => {
      const at = (document.documentElement as unknown as Record<symbol, unknown>)[Symbol.for(`${key}.tick`)];
      return typeof at === 'number' ? Date.now() - at : null;
    }, HIGHLIGHT_REGISTRY_KEY);

  it('a ring drawn in it through a Page attached afterwards is hidden from that Page\'s model capture', async () => {
    const page = await attached();
    const child = await childById(page, 'xs');
    const lazy = await childById(page, 'lazy');
    const lazyAsked = vi.spyOn(lazy, 'evaluate');
    createHighlighter({ ...HIGHLIGHT_DEFAULTS, durationMs: 10_000 }, { now: () => 9.5e15 })
      .mark(page.frameLocator('#xs').locator('#b'), 'act');
    await vi.waitFor(async () => {
      if ((await visibility(child as unknown as Page)) !== 'visible') throw new Error('no ring in the frame yet');
    }, { timeout: 10_000, interval: 50 });
    expect(await hiddenFor(page, () => visibility(child as unknown as Page), { now: () => 9.5e15 })).toBe('hidden');
    // Shown again once the restore lands (a condition: see the javascript: case).
    await vi.waitFor(async () => {
      if ((await visibility(child as unknown as Page)) !== 'visible') throw new Error('the restore has not landed yet');
    }, { timeout: 10_000, interval: 50 });
    // The lazy frame's own context was never entered (review 21, item 1): it
    // is asked through its parent, which reaches its empty document.
    expect(lazyAsked).not.toHaveBeenCalled();
  });

  it('a hide in an out-of-process frame is painted before the picture is taken (review 24, item 1)', async () => {
    // A screenshot composites an out-of-process frame's LAST PAINTED picture.
    // A ring that has stopped moving (reduced motion: no pulse, no scale)
    // leaves that frame with nothing to paint, so a hide that has landed in
    // its DOM is not on screen until the frame paints again.
    const page = await attached();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    try {
      const child = await childById(page, 'xs');
      const paints = (): Promise<unknown> =>
        child.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const ringPixels = async (shot: Buffer, base: Buffer): Promise<number> => {
        const [a, b] = await Promise.all([Jimp.read(shot), Jimp.read(base)]);
        let count = 0;
        a.scan(0, 0, a.bitmap.width, a.bitmap.height, (_x, _y, i) => {
          const r = a.bitmap.data[i]!;
          const g = a.bitmap.data[i + 1]!;
          const bl = a.bitmap.data[i + 2]!;
          const changed = Math.abs(r - b.bitmap.data[i]!) + Math.abs(g - b.bitmap.data[i + 1]!) + Math.abs(bl - b.bitmap.data[i + 2]!);
          if (bl - r > 12 && changed > 30) count++;
        });
        return count;
      };
      // Start from a frame with no ring in it: another case may have drawn
      // one there that is still up.
      await child.evaluate((tag) => document.documentElement.querySelector(`:scope > ${tag}`)?.remove(), HIGHLIGHT_TAG);
      await paints();
      const base = await page.screenshot();
      const clock = { now: () => 9.7e15 };
      const settings = { ...HIGHLIGHT_DEFAULTS, durationMs: 10_000 };
      const ring = page.frameLocator('#xs').locator('#b');
      createHighlighter(settings, clock).mark(ring, 'act');
      // The ring is up in the frame, and painted. Its records live on the
      // fixed clock; in the page it lives 10 s, so it is drawn again (which
      // restarts it) every few captures: on a loaded machine 25 captures can
      // outlast it, and a retired ring could neither leak nor be hidden.
      const ringUp = async (): Promise<void> => {
        await vi.waitFor(async () => {
          if ((await visibility(child as unknown as Page)) !== 'visible') throw new Error('no ring showing in the frame');
        }, { timeout: 10_000, interval: 50 });
        await paints();
      };
      await ringUp();
      expect(await ringPixels(await page.screenshot(), base)).toBeGreaterThan(500); // the ring is on screen
      const leaks: number[] = [];
      for (let i = 0; i < 25; i++) {
        if (i > 0 && i % 5 === 0) {
          expect(await drawRings(ring, 'act', settings)).toBe(1);
          await ringUp();
        }
        const shot = await hiddenFor(page, () => page.screenshot(), clock);
        leaks.push(await ringPixels(shot, base));
        await paints(); // the restore painted: the next hide starts from a ring on screen
      }
      // The ring was up for every one of them: still there after the last.
      await ringUp();
      expect(leaks).toEqual(Array(25).fill(0));

      // The mechanism itself, which does not depend on catching a stale
      // picture: by the time the picture is taken, the frame has run at least
      // two animation frames since its hide landed. On a fresh ring, so it
      // cannot have retired meanwhile.
      expect(await drawRings(ring, 'act', settings)).toBe(1);
      await ringUp();
      await child.evaluate((tag) => {
        const w = window as unknown as { frames_: number; hiddenAt: number; counting_: boolean };
        w.frames_ = 0;
        w.hiddenAt = -1;
        w.counting_ = true;
        const tick = (): void => {
          if (!w.counting_) return;
          w.frames_++;
          const host = document.documentElement.querySelector(`:scope > ${tag}`) as HTMLElement | null;
          if (w.hiddenAt < 0 && host?.style.getPropertyValue('visibility') === 'hidden') w.hiddenAt = w.frames_;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }, HIGHLIGHT_TAG);
      try {
        const framesSinceHide = await hiddenFor(page, () => child.evaluate(() => {
          const w = window as unknown as { frames_: number; hiddenAt: number };
          return w.hiddenAt < 0 ? -1 : w.frames_ - w.hiddenAt;
        }), clock);
        expect(framesSinceHide).toBeGreaterThanOrEqual(1);
      } finally {
        await child.evaluate(() => {
          (window as unknown as { counting_: boolean }).counting_ = false;
        });
      }
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }
    // 26 captures and four redraws: on a loaded machine that outlasts the
    // default 30 s, which is a budget for the run, not a check on it.
  }, 120_000);

  it('a ring in a javascript: frame the page filled is hidden from an attached Page\'s model capture (review 23)', async () => {
    const page = await attached();
    const js = await childById(page, 'js');
    expect(['', ':']).toContain(js.url()); // Playwright reports no address for it
    createHighlighter({ ...HIGHLIGHT_DEFAULTS, durationMs: 10_000 }, { now: () => 9.6e15 })
      .mark(page.frameLocator('#js').locator('#jb'), 'act');
    await vi.waitFor(async () => {
      if ((await childVisibility(page, 'js')) !== 'visible') throw new Error('no ring in the frame yet');
    }, { timeout: 10_000, interval: 50 });
    expect(await hiddenFor(page, () => childVisibility(page, 'js'), { now: () => 9.6e15 })).toBe('hidden');
    // Shown again once the restore lands: awaited within 500 ms, which a
    // loaded machine can outrun, so a condition rather than one read.
    await vi.waitFor(async () => {
      if ((await childVisibility(page, 'js')) !== 'visible') throw new Error('the restore has not landed yet');
    }, { timeout: 10_000, interval: 50 });
  });

  it('a hide waits for a paint only in a frame Chrome is drawing: not in a cross-site frame out of view (review 25, item 1)', async () => {
    // Chrome draws nothing of a cross-site frame scrolled out of view: it runs
    // no animation frames, and a capture shows none of it. A hide there lands
    // and returns at once, where waiting for a paint would cost every capture
    // the whole budget for as long as its ring is up.
    const page = await attached();
    await page.evaluate(() => window.scrollTo(0, 0));
    const near = await childById(page, 'xs');
    const far = await childById(page, 'far');
    const clock = { now: () => 9.8e15 };
    const highlighter = createHighlighter({ ...HIGHLIGHT_DEFAULTS, durationMs: 10_000 }, clock);
    highlighter.mark(page.frameLocator('#xs').locator('#b'), 'act');
    highlighter.mark(page.frameLocator('#far').locator('#b'), 'act');
    try {
      await vi.waitFor(async () => {
        if ((await visibility(near as unknown as Page)) !== 'visible') throw new Error('no ring in the near frame yet');
        if ((await visibility(far as unknown as Page)) !== 'visible') throw new Error('no ring in the far frame yet');
      }, { timeout: 10_000, interval: 50 });
      // The precondition, by condition rather than by timing: the near frame
      // is being drawn, the far one is not.
      await vi.waitFor(async () => {
        const nearAge = await sinceDrawn(near);
        if (nearAge === null || nearAge > 50) throw new Error(`the near frame is not being drawn (${nearAge})`);
        const farAge = await sinceDrawn(far);
        if (farAge !== null && farAge <= 150) throw new Error(`the far frame is still being drawn (${farAge})`);
      }, { timeout: 10_000, interval: 50 });
      await countTimers(near);
      await countTimers(far);
      try {
        expect(await hiddenFor(page, async () => [
          await visibility(near as unknown as Page),
          await visibility(far as unknown as Page),
        ], clock)).toEqual(['hidden', 'hidden']);
        expect(await timersIn(far)).toBe(0); // hidden, with no paint to wait for
        expect(await timersIn(near)).toBeGreaterThanOrEqual(1); // the paint wait, where there is a paint
      } finally {
        await uncountTimers(near);
        await uncountTimers(far);
      }
    } finally {
      await endRings([page], clock);
    }
  });

  it('a hide in the main frame does not wait for a paint; an end there does (review 25, item 2)', async () => {
    // A capture draws the main document afresh, so a hide that has landed
    // there is in the picture with no wait. An end is followed by a grab of
    // the screen, which draws nothing new: it waits in every frame.
    const page = await attached();
    const main = page.mainFrame();
    const clock = { now: () => 9.9e15 };
    createHighlighter({ ...HIGHLIGHT_DEFAULTS, durationMs: 10_000 }, clock).mark(page.locator('p').first(), 'act');
    try {
      await vi.waitFor(async () => {
        if ((await visibility(page)) !== 'visible') throw new Error('no ring in the main frame yet');
        const age = await sinceDrawn(main);
        if (age === null || age > 50) throw new Error(`the main frame is not being drawn (${age})`);
      }, { timeout: 10_000, interval: 50 });
      await countTimers(main);
      try {
        expect(await hiddenFor(page, () => visibility(page), clock)).toBe('hidden');
        expect(await timersIn(main)).toBe(0);
        await endRings([page], clock);
        expect(await visibility(page)).toBeNull();
        expect(await timersIn(main)).toBeGreaterThanOrEqual(1);
      } finally {
        await uncountTimers(main);
      }
    } finally {
      await endRings([page], clock);
    }
  });
});
