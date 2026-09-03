import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { BrowserTracker, PageTracker, type BrowserSession } from '../src/browser/manager.js';
import {
  CodeBehindTrackerUnavailableError,
  makeBrowserApi,
  makeTabApi,
  unavailableBrowserApi,
  unavailableTabApi,
} from '../src/codebehind/tabs.js';

/**
 * `ctx.tabs` against a real browser
 * (stories/codebehind-framework-actions.md).
 *
 * A real one because every interesting property here is about the tracker and
 * Playwright agreeing: that `context.on('page')` has registered a tab by the
 * time we relabel it, that `openedBy` catches a popup opened synchronously on
 * a click, that closing a tab moves the active pointer. A fake tracker would
 * assert that the code calls the methods it calls, which is the one thing not
 * in doubt.
 *
 * No fixture server though — pages are served by `context.route`, so this
 * still runs in the fast suite.
 */

/**
 * Pages served by `context.route`, not by a server and not as `data:` URLs.
 *
 * `data:` was the obvious choice and is wrong for exactly the case that
 * matters: Chromium blocks a top-level navigation to a `data:` URL, so
 * `window.open('data:...')` — the whole `openedBy` scenario — opens nothing.
 * Routed http URLs are real navigations to the browser, with no server to
 * start, so this still belongs in the fast suite.
 */
const ORIGIN = 'http://tabs.test';
const ALPHA = `${ORIGIN}/alpha`;
const BETA = `${ORIGIN}/beta`;
const OPENER = `${ORIGIN}/opener`;

const BODIES: Record<string, string> = {
  '/alpha': '<title>Alpha</title><h1>alpha</h1>',
  '/beta': '<title>Beta</title><h1>beta</h1>',
  '/opener':
    `<title>Opener</title><button id="go" onclick="window.open('${BETA}','_blank')">Open</button>`,
};

let browser: Browser;
let context: BrowserContext;
let mainPage: Page;

/** A tracker wired the way `launchBrowser` wires the real one. */
function trackedContext(): PageTracker {
  const tracker = new PageTracker(mainPage);
  context.on('page', (p) => { tracker.addPage(p); });
  return tracker;
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
}, 15_000);

beforeEach(async () => {
  // A fresh context per test: `context.on('page')` listeners accumulate, and a
  // tracker from a previous test would keep adopting this one's tabs.
  if (context) await context.close().catch(() => {});
  context = await browser.newContext();
  await context.route(`${ORIGIN}/**`, async (route) => {
    const body = BODIES[new URL(route.request().url()).pathname];
    if (body === undefined) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: 'text/html', body });
  });
  mainPage = await context.newPage();
  await mainPage.goto(ALPHA, { waitUntil: 'domcontentloaded' });
});

describe('ctx.tabs — open', () => {
  it('opens a tab, makes it active, and returns the handle for it', async () => {
    const tracker = trackedContext();
    const tabs = makeTabApi(tracker);

    const opened = await tabs.open(BETA);

    expect(await opened.title()).toBe('Beta');
    // The load-bearing property: the run's tracker moved, so the natural-
    // language steps that follow this entry target the new tab.
    expect(tracker.getActive()).toBe(opened);
    expect(tabs.list().map((t) => t.label)).toEqual(['main', 'page:2']);
  });

  it('names the tab when `as` is given, so a later switchTo is exact', async () => {
    const tracker = trackedContext();
    const tabs = makeTabApi(tracker);

    await tabs.open(BETA, { as: 'docs' });
    await tabs.switchTo('main');
    const back = await tabs.switchTo('docs');

    expect(await back.title()).toBe('Beta');
    expect(tabs.list().find((t) => t.isActive)?.label).toBe('docs');
  });

  it('promotes the tab it opened, not a same-URL sibling', async () => {
    // The AI `openPage` handler switches with `switchToAsync(newPage.url())`,
    // a URL SUBSTRING match — with two tabs on one URL it can promote the
    // wrong one and the caller cannot tell, because a Page still comes back.
    // This API switches by the tracked label, which is identity.
    const tracker = trackedContext();
    const tabs = makeTabApi(tracker);

    const first = await tabs.open(BETA);
    const second = await tabs.open(BETA);

    expect(second).not.toBe(first);
    expect(tracker.getActive()).toBe(second);
  });

  it('closes the tab and rethrows when navigation fails, leaving no orphan', async () => {
    const tracker = trackedContext();
    const tabs = makeTabApi(tracker);

    await expect(tabs.open('http://127.0.0.1:1/nothing-here')).rejects.toThrow();
    // The failed tab must not be left open and active — the following steps
    // would run in a blank tab that looks like a page.
    expect(tracker.getActive()).toBe(mainPage);
  });
});

describe('ctx.tabs — openedBy', () => {
  it('adopts the tab the page opened and makes it active', async () => {
    const tracker = trackedContext();
    const tabs = makeTabApi(tracker);
    await mainPage.goto(OPENER, { waitUntil: 'domcontentloaded' });

    const popup = await tabs.openedBy(() => mainPage.locator('#go').click());

    expect(await popup.title()).toBe('Beta');
    expect(tracker.getActive()).toBe(popup);
  });

  it('fails with a named error when the trigger opens nothing', async () => {
    const tracker = trackedContext();
    const tabs = makeTabApi(tracker);

    await expect(
      tabs.openedBy(() => mainPage.locator('h1').click(), { timeoutMs: 500 }),
    ).rejects.toThrow(/no new tab appeared/);
  });
});

describe('ctx.tabs — switchTo and close', () => {
  it('switches by label, URL substring and title substring', async () => {
    const tracker = trackedContext();
    const tabs = makeTabApi(tracker);
    await tabs.open(BETA, { as: 'beta' });

    expect(await (await tabs.switchTo('main')).title()).toBe('Alpha');
    expect(await (await tabs.switchTo('beta')).title()).toBe('Beta');
    expect(await (await tabs.switchTo('main')).title()).toBe('Alpha');
    // Title matching is the tracker's third fallback — the identifier a
    // `switchPage` transcript carries is often exactly this.
    expect(await (await tabs.switchTo('Beta')).title()).toBe('Beta');
  });

  it('throws and names the open tabs when nothing matches', async () => {
    const tracker = trackedContext();
    const tabs = makeTabApi(tracker);

    await expect(tabs.switchTo('nowhere')).rejects.toThrow(/no tab matching "nowhere"/);
  });

  it('closes a tab and returns the page that is active afterwards', async () => {
    const tracker = trackedContext();
    const tabs = makeTabApi(tracker);
    await tabs.open(BETA, { as: 'beta' });

    const active = await tabs.close('beta');

    expect(active).toBe(mainPage);
    expect(tabs.list().map((t) => t.label)).toEqual(['main']);
  });

  it('refuses to close the main tab', async () => {
    const tracker = trackedContext();
    const tabs = makeTabApi(tracker);

    await expect(tabs.close('main')).rejects.toThrow(/cannot close the main page/);
  });
});

describe('ctx.tabs — the focus hook', () => {
  it('raises every tab it makes active, so a headed run stays watchable', async () => {
    const tracker = trackedContext();
    const raised: string[] = [];
    const tabs = makeTabApi(tracker, {
      focus: async (p) => { raised.push(await p.title()); },
    });

    await tabs.open(BETA);
    await tabs.switchTo('main');

    expect(raised).toEqual(['Beta', 'Alpha']);
  });

  it('does not fail a step when raising the tab throws', async () => {
    const tracker = trackedContext();
    const tabs = makeTabApi(tracker, {
      focus: async () => { throw new Error('no display'); },
    });

    // Cosmetic: bringToFront is best-effort in the AI path too.
    await expect(tabs.open(BETA)).resolves.toBeDefined();
  });
});

describe('ctx.browsers', () => {
  /**
   * A real session, built the way the CDP path builds one — enough for the
   * tracker, without a `launchBrowser` and its whole `BrowserConfig`.
   *
   * Left on `about:blank`: these tests are about labels, promotion and the
   * active pointer, and navigating would only tie them to the routed origin
   * the tab tests set up on a different context.
   */
  /** Browsers these tests launched, closed in `afterEach` — `browsers.close`
   *  really closes the `Browser`, so sharing the suite-wide one would kill it
   *  for every test that follows. */
  const launchedHere: Browser[] = [];

  async function session(engine = 'chromium', channel = 'chrome'): Promise<BrowserSession> {
    const own = await chromium.launch({ headless: true });
    launchedHere.push(own);
    const ctx = await own.newContext();
    const page = await ctx.newPage();
    return { browser: own, context: ctx, page, pageTracker: new PageTracker(page), engine, channel };
  }

  afterEach(async () => {
    await Promise.all(launchedHere.splice(0).map((b) => b.close().catch(() => {})));
  });

  it('opens a browser, auto-promotes it, and returns its active page', async () => {
    const initial = await session();
    const tracker = new BrowserTracker(initial);
    const launched: unknown[] = [];
    const browsers = makeBrowserApi(tracker, async (overrides) => {
      launched.push(overrides);
      return session('firefox', '');
    });

    const page = await browsers.open('worker', { engine: 'firefox' });

    // Auto-promote is the `openBrowser` precedent: "open a second browser and
    // sign in there" must not need a switch step wedged in between.
    expect(tracker.getActiveLabel()).toBe('worker');
    expect(page).toBe(tracker.getActivePage());
    expect(launched).toEqual([{ engine: 'firefox' }]);
    expect(browsers.list().map((b) => b.label)).toEqual(['default', 'worker']);


  });

  it('refuses a label that is already taken', async () => {
    const tracker = new BrowserTracker(await session());
    const browsers = makeBrowserApi(tracker, () => { throw new Error('must not launch'); });

    await expect(browsers.open('default')).rejects.toThrow(/already in use/);
  });

  it('switches back to the browser the test started in', async () => {
    const initial = await session();
    const tracker = new BrowserTracker(initial);
    const browsers = makeBrowserApi(tracker, () => session());

    await browsers.open('worker');
    const back = await browsers.switchTo('default');

    expect(back).toBe(initial.page);
    expect(browsers.activeLabel()).toBe('default');
    expect(browsers.list().find((b) => b.isActive)?.label).toBe('default');


  });

  it('names the known labels when asked for one that is not tracked', async () => {
    const tracker = new BrowserTracker(await session());
    const browsers = makeBrowserApi(tracker, () => session());

    await expect(browsers.switchTo('nope')).rejects.toThrow(/known: default/);
  });

  it('closes a browser and drops it from the list', async () => {
    const tracker = new BrowserTracker(await session());
    const browsers = makeBrowserApi(tracker, () => session());
    await browsers.open('worker');

    await browsers.close('worker');

    // `close` returns void on purpose: closing the last browser leaves no
    // active session, so there is no honest page to hand back. A step that
    // closes one asserts over `list()`.
    expect(browsers.list().map((b) => b.label)).toEqual(['default']);
  });
});

describe('the unavailable APIs', () => {
  it('throw rather than no-op when the run has no tracker', () => {
    const tabs = unavailableTabApi();
    // A silent no-op would leave the following steps on the wrong tab with
    // everything green; a throw heals to AI and flags the entry stale.
    expect(() => tabs.list()).toThrow(CodeBehindTrackerUnavailableError);
    expect(() => tabs.active()).toThrow(/page tracking is not enabled/);
    expect(() => unavailableBrowserApi().activeLabel()).toThrow(/browser tracking is not enabled/);
  });

  it('names the method that was called', async () => {
    await expect(unavailableTabApi().switchTo('main')).rejects.toThrow(/tabs\.switchTo/);
    await expect(unavailableBrowserApi().open('worker')).rejects.toThrow(/browsers\.open/);
  });
});
