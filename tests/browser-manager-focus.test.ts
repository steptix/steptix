import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserConfig } from '../src/config/types.js';

// ---------------------------------------------------------------------------
// What `launchBrowser` records and raises (stories/cdp-tab-focus.md §3).
//
// This is the layer every other suite mocks away. `tests/api-server*.test.ts`,
// `tests/session-manager.test.ts` and `tests/mcp-real-app-seam.test.ts` all
// stub `launchBrowser` wholesale, so nothing observed either of the two things
// this file is about:
//
//   1. **`BrowserSession.headed`**, which the step executor's §4 gate reads to
//      decide whether raising a tab is worth doing. Delete the field from the
//      session literal and every other test still passes — the gate falls back
//      to `config.browser.headed`, which agrees in the single-browser case and
//      disagrees exactly where `openBrowser` overrode it.
//   2. **The attach-to-an-existing-tab raise** (§3 / verification rule 7). It
//      is one line on a branch whose sibling already had it, which is precisely
//      the kind of line that gets dropped in a refactor with nothing to notice.
//
// Playwright is mocked at the module boundary rather than driven for real:
// what is under test is which calls `manager.ts` makes and what it records, not
// whether Chromium raises a window — that part no assertion in this repo can
// see (rule 1), and the live suite covers what is observable.
// ---------------------------------------------------------------------------

const connectOverCDP = vi.fn();
const launch = vi.fn();
const stealthLaunch = vi.fn();

vi.mock('playwright', () => ({
  chromium: {
    connectOverCDP: (...args: unknown[]) => connectOverCDP(...args),
    launch: (...args: unknown[]) => launch(...args),
  },
  firefox: { launch: (...args: unknown[]) => launch(...args) },
  webkit: { launch: (...args: unknown[]) => launch(...args) },
}));

vi.mock('playwright-extra', () => ({
  chromium: {
    launch: (...args: unknown[]) => stealthLaunch(...args),
    use: vi.fn(),
  },
}));

vi.mock('puppeteer-extra-plugin-stealth', () => ({ default: () => ({}) }));

const { launchBrowser } = await import('../src/browser/manager.js');

const CDP_PORT = 51000;

function baseConfig(over: Partial<BrowserConfig> = {}): BrowserConfig {
  return {
    headed: true,
    browser: 'chromium',
    slowMo: 0,
    viewport: { width: 1280, height: 720 },
    windowSize: { width: 1280, height: 720 },
    fullPageScreenshots: true,
    ...over,
  } as BrowserConfig;
}

/** A page that records `bringToFront`, and answers the handful of calls the
 *  launch/attach paths make on it. */
function fakePage(url = 'https://shop.example/cart') {
  return {
    url: () => url,
    bringToFront: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
  };
}

/** A fake Playwright browser whose single context holds `pages`, and whose
 *  `newPage()` hands back a fresh one. */
function fakeBrowser(pages: ReturnType<typeof fakePage>[]) {
  const opened: ReturnType<typeof fakePage>[] = [];
  const context = {
    pages: () => pages,
    newPage: vi.fn(async () => {
      const p = fakePage('about:blank');
      opened.push(p);
      pages.push(p);
      return p;
    }),
    on: vi.fn(),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    grantPermissions: vi.fn(async () => {}),
  };
  return {
    browser: {
      contexts: () => [context],
      newContext: vi.fn(async () => context),
      version: () => '150.0.0.0',
      close: vi.fn(async () => {}),
    },
    context,
    opened,
  };
}

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  connectOverCDP.mockReset();
  launch.mockReset();
  stealthLaunch.mockReset();
  // `preflightCdpPort` probes /json/version before connecting.
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// §3 — attaching to an existing tab brings it forward
// ---------------------------------------------------------------------------

describe('CDP attach (stories/cdp-tab-focus.md §3)', () => {
  it('brings an EXISTING tab forward, closing the gap its `new`-tab sibling never had', async () => {
    // Verification rule (7). Before this, a user who named the tab they wanted
    // the run to use watched their carefully arranged cart sit untouched while
    // steps ran behind it — the `new` branch raised its tab and the attach
    // branch did not, an asymmetry with no defence.
    const cart = fakePage('https://shop.example/cart');
    const other = fakePage('https://shop.example/');
    const { browser } = fakeBrowser([other, cart]);
    connectOverCDP.mockResolvedValue(browser);

    const session = await launchBrowser(baseConfig(), {
      port: CDP_PORT,
      tab: 'url~/cart',
    });

    expect(session.page).toBe(cart);
    expect(cart.bringToFront).toHaveBeenCalledTimes(1);
    // And nothing was opened — attaching to a named tab must not also spawn one.
    expect(other.bringToFront).not.toHaveBeenCalled();
    expect(session.cdpTabOpenedByUs).toBeFalsy();
  });

  it('still raises the tab it opens itself', async () => {
    // The sibling behaviour, pinned so a future change cannot fix one branch by
    // breaking the other.
    const existing = fakePage('https://shop.example/');
    const { browser, opened } = fakeBrowser([existing]);
    connectOverCDP.mockResolvedValue(browser);

    const session = await launchBrowser(baseConfig(), { port: CDP_PORT });

    expect(session.cdpTabOpenedByUs).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.bringToFront).toHaveBeenCalledTimes(1);
    expect(existing.bringToFront).not.toHaveBeenCalled();
  });

  it('does not fail the attach when the browser refuses to raise the window', async () => {
    // Windows can decline a foreground request from a background process. The
    // two neighbouring calls swallow that silently; this one must too, or a
    // refused raise turns into a failed session.
    const cart = fakePage('https://shop.example/cart');
    cart.bringToFront.mockRejectedValue(new Error('not permitted'));
    const { browser } = fakeBrowser([cart]);
    connectOverCDP.mockResolvedValue(browser);

    const session = await launchBrowser(baseConfig(), { port: CDP_PORT, tab: 'url~/cart' });

    expect(session.page).toBe(cart);
    expect(cart.bringToFront).toHaveBeenCalled();
  });

  it('leaves the tab where it is under activate: false (stories/tab-peek.md item 5)', async () => {
    // The peek's whole promise, and this is the ONLY suite that can fail on
    // it: every other harness stubs `launchBrowser` wholesale, so a
    // mocked-manager test asserting "no raise" would be asserting its own
    // fake. §3's courtesy exists because a run is about to DRIVE behind the
    // tab you are looking at; a read drives nothing and shows nothing, so
    // raising would only interrupt whatever the user was actually doing.
    const cart = fakePage('https://shop.example/cart');
    const other = fakePage('https://shop.example/');
    const { browser } = fakeBrowser([other, cart]);
    connectOverCDP.mockResolvedValue(browser);

    const session = await launchBrowser(baseConfig(), {
      port: CDP_PORT,
      tab: 'url~/cart',
      activate: false,
    });

    // It still attached to the right tab — the flag turns off the raise, not
    // the resolution.
    expect(session.page).toBe(cart);
    expect(cart.bringToFront).not.toHaveBeenCalled();
    expect(other.bringToFront).not.toHaveBeenCalled();
    // And nothing was opened or closed on the way: a peek's detach severs the
    // socket and no more.
    expect(session.cdpTabOpenedByUs).toBeFalsy();
  });

  it('raises on an explicit activate: true, so the default is a value and not an absence', async () => {
    // The control for the test above. Without it, a gate written the wrong way
    // round (`if (cdp.activate === false)` inverted, or the raise deleted
    // outright) still passes the no-raise assertion.
    const cart = fakePage('https://shop.example/cart');
    const { browser } = fakeBrowser([cart]);
    connectOverCDP.mockResolvedValue(browser);

    await launchBrowser(baseConfig(), { port: CDP_PORT, tab: 'url~/cart', activate: true });

    expect(cart.bringToFront).toHaveBeenCalledTimes(1);
  });

  it('still raises the tab it opens itself, whatever activate says', async () => {
    // The `new`-tab arm is deliberately NOT gated: it opens a window that has
    // to appear somewhere, and no caller has asked not to see one. A peek
    // never takes this arm — it always sends an exact `targetId:` — so
    // widening the gate here would be a change nothing asked for.
    const existing = fakePage('https://shop.example/');
    const { browser, opened } = fakeBrowser([existing]);
    connectOverCDP.mockResolvedValue(browser);

    const session = await launchBrowser(baseConfig(), { port: CDP_PORT, activate: false });

    expect(session.cdpTabOpenedByUs).toBe(true);
    expect(opened[0]!.bringToFront).toHaveBeenCalledTimes(1);
  });

  it('records the session as headed — a CDP browser is one a human is looking at', async () => {
    // Read by the §4 gate. `headed: false` is one of the settings
    // `incompatibleCdpConfig` already reports as ignored in this mode, so the
    // session must not inherit it from the config.
    const cart = fakePage('https://shop.example/cart');
    const { browser } = fakeBrowser([cart]);
    connectOverCDP.mockResolvedValue(browser);

    const session = await launchBrowser(baseConfig({ headed: false }), {
      port: CDP_PORT,
      tab: 'url~/cart',
    });

    expect(session.headed).toBe(true);
    expect(session.cdp).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `BrowserSession.headed` on the launch path — the field the §4 gate reads
// ---------------------------------------------------------------------------

describe('launchBrowser records its own headedness', () => {
  function launchFake() {
    const { browser, context, opened } = fakeBrowser([]);
    stealthLaunch.mockResolvedValue(browser);
    launch.mockResolvedValue(browser);
    return { browser, context, opened };
  }

  it('records headed: true, and raises the window it just opened', async () => {
    const { opened } = launchFake();
    const session = await launchBrowser(baseConfig({ headed: true }));

    expect(session.headed).toBe(true);
    expect(opened[0]!.bringToFront).toHaveBeenCalledTimes(1);
  });

  it('records headed: false, and does not bother raising anything', async () => {
    const { opened } = launchFake();
    const session = await launchBrowser(baseConfig({ headed: false }));

    expect(session.headed).toBe(false);
    expect(opened[0]!.bringToFront).not.toHaveBeenCalled();
  });

  it('records the OVERRIDE, not the shared config — this is the whole point', async () => {
    // `openBrowser` can pick its own headedness per browser, so one run holds a
    // headed browser and a headless one at once. If the session recorded the
    // config instead of the override, the §4 gate would consult a setting that
    // does not describe the browser it is asking about — and the two disagree
    // only here, which is exactly where it matters.
    const { opened } = launchFake();
    const headless = await launchBrowser(baseConfig({ headed: true }), undefined, {
      headed: false,
    });
    expect(headless.headed).toBe(false);
    expect(opened[0]!.bringToFront).not.toHaveBeenCalled();

    const second = launchFake();
    const headful = await launchBrowser(baseConfig({ headed: false }), undefined, {
      headed: true,
    });
    expect(headful.headed).toBe(true);
    expect(second.opened[0]!.bringToFront).toHaveBeenCalledTimes(1);
  });
});
