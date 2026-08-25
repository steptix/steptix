/**
 * `launchBrowser` under `BrowserConfig.fixedViewport`
 * (stories/per-test-viewport.md §2/§10).
 *
 * The property a CSS-breakpoint test depends on is one thing: the CONTEXT gets
 * exactly the requested viewport, in BOTH modes. Today's headed path passes
 * `viewport: null` and takes the window's size, so a per-test viewport that
 * only worked headless would silently no-op in the default setup — which is
 * why the headed assertions here are the load-bearing ones, not a symmetry
 * flourish.
 *
 * Playwright is mocked at the module boundary, the same way
 * browser-manager-focus.test.ts does it: what is under test is the arguments
 * `manager.ts` builds, and a headed assertion that needed a real window would
 * be unrunnable on a build machine.
 *
 * Note what is NOT primed here: `baseConfig()` has no `fixedViewport`, and the
 * "unchanged" block below asserts against that bare config. Priming it into the
 * shared fixture would condition the very regression this file exists to catch
 * (§10's minimum-scenario rule).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserConfig } from '../src/config/types.js';

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

const { launchBrowser, incompatibleCdpConfig } = await import('../src/browser/manager.js');

const MOBILE = { width: 390, height: 844 };

function baseConfig(over: Partial<BrowserConfig> = {}): BrowserConfig {
  return {
    headed: true,
    browser: 'chromium',
    slowMo: 0,
    viewport: { width: 1280, height: 720 },
    windowSize: { width: 1600, height: 1000 },
    fullPageScreenshots: true,
    ...over,
  } as BrowserConfig;
}

function fakePage() {
  return {
    url: () => 'about:blank',
    bringToFront: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
  };
}

function fakeBrowser() {
  const pages: ReturnType<typeof fakePage>[] = [];
  const context = {
    pages: () => pages,
    newPage: vi.fn(async () => {
      const p = fakePage();
      pages.push(p);
      return p;
    }),
    on: vi.fn(),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    grantPermissions: vi.fn(async () => {}),
  };
  const newContext = vi.fn(async () => context);
  return {
    browser: {
      contexts: () => [context],
      newContext,
      version: () => '150.0.0.0',
      close: vi.fn(async () => {}),
    },
    newContext,
  };
}

/** Wire both chromium drivers (stealth and plain) to one fake browser. */
function launchFake(): { newContext: ReturnType<typeof vi.fn> } {
  const { browser, newContext } = fakeBrowser();
  stealthLaunch.mockResolvedValue(browser);
  launch.mockResolvedValue(browser);
  return { newContext };
}

/** The `viewport` option `newContext` was handed. */
function contextViewport(newContext: ReturnType<typeof vi.fn>): unknown {
  return (newContext.mock.calls[0]![0] as { viewport: unknown }).viewport;
}

/** The `--window-size=W,H` the browser was launched with. */
function windowSizeArg(): { width: number; height: number } {
  const call = (stealthLaunch.mock.calls[0] ?? launch.mock.calls[0])!;
  const args = (call[0] as { args: string[] }).args;
  const match = /^--window-size=(\d+),(\d+)$/.exec(
    args.find((a) => a.startsWith('--window-size=')) ?? '',
  );
  if (!match) throw new Error(`no --window-size in ${JSON.stringify(args)}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  connectOverCDP.mockReset();
  launch.mockReset();
  stealthLaunch.mockReset();
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// §2 — exact page size, both modes
// ---------------------------------------------------------------------------

describe('fixedViewport pins the context viewport', () => {
  it('HEADED: the context gets the exact size, not the null that means "ask the window"', async () => {
    // The whole feature, in one assertion. Headed is the default and what a
    // TestBench user watches, and `viewport: null` there is why setting
    // `browser.viewport` today does nothing in the setup people actually run.
    const { newContext } = launchFake();
    await launchBrowser(baseConfig({ headed: true, fixedViewport: MOBILE }));

    expect(contextViewport(newContext)).toEqual(MOBILE);
  });

  it('HEADLESS: the context gets the exact size, overriding browser.viewport', async () => {
    // `viewport` (1280×720 here) is the value the headless path would otherwise
    // use, so this fails loudly if `fixedViewport` is merely appended rather
    // than winning.
    const { newContext } = launchFake();
    await launchBrowser(baseConfig({ headed: false, fixedViewport: MOBILE }));

    expect(contextViewport(newContext)).toEqual(MOBILE);
  });

  it('survives an engine / headed override on the launch — openBrowser inherits it (§2)', async () => {
    // The mid-test `openBrowser` action relaunches from `config.browser` with
    // its own overrides. A secondary browser in a `viewport: mobile` test is
    // also mobile, and picking a different engine must not clear the size.
    const { newContext } = launchFake();
    await launchBrowser(baseConfig({ headed: true, fixedViewport: MOBILE }), undefined, {
      engine: 'firefox',
      headed: false,
    });

    expect(contextViewport(newContext)).toEqual(MOBILE);
  });
});

describe('fixedViewport shapes the headed window', () => {
  it('HEADED: the window is the page plus a chrome allowance, not the desktop windowSize', async () => {
    // Cosmetic, and deliberately loose: the point is that a phone-width run
    // looks like a phone rather than a 390px strip inside a 1600px window.
    // Asserted as a band, not an exact number, so tuning the allowance is not
    // a test edit.
    launchFake();
    await launchBrowser(baseConfig({ headed: true, fixedViewport: MOBILE }));

    const { width, height } = windowSizeArg();
    expect(width).toBe(MOBILE.width);
    expect(height).toBeGreaterThan(MOBILE.height);
    expect(height).toBeLessThan(MOBILE.height + 200);
  });

  it('HEADLESS: the window matches the page exactly — no chrome, nobody watching', async () => {
    launchFake();
    await launchBrowser(baseConfig({ headed: false, fixedViewport: MOBILE }));

    expect(windowSizeArg()).toEqual(MOBILE);
  });
});

// ---------------------------------------------------------------------------
// Without the key — byte-for-byte today's behaviour (§2/§10)
// ---------------------------------------------------------------------------

describe('without fixedViewport, nothing changes', () => {
  it('HEADED still passes viewport: null and sizes the window from windowSize', async () => {
    const { newContext } = launchFake();
    await launchBrowser(baseConfig({ headed: true }));

    expect(contextViewport(newContext)).toBeNull();
    expect(windowSizeArg()).toEqual({ width: 1600, height: 1000 });
  });

  it('HEADLESS still passes browser.viewport and sizes the window from it', async () => {
    const { newContext } = launchFake();
    await launchBrowser(baseConfig({ headed: false }));

    expect(contextViewport(newContext)).toEqual({ width: 1280, height: 720 });
    expect(windowSizeArg()).toEqual({ width: 1280, height: 720 });
  });
});

// ---------------------------------------------------------------------------
// CDP refuses, rather than warning (§2)
// ---------------------------------------------------------------------------

describe('CDP attach + fixedViewport', () => {
  it('throws before connecting to anything', async () => {
    // An error, not the existing warn: the whole test was authored around a
    // size we cannot impose on the user's own Chrome, so a "pass" at the wrong
    // size is the one outcome worse than refusing to start. Nothing must be
    // attached to on the way out — a leaked CDP connection holds the
    // context-wide dialog guard for the life of the server process.
    await expect(
      launchBrowser(baseConfig({ fixedViewport: MOBILE }), { port: 9222 }),
    ).rejects.toThrow(/cannot be applied to a browser attached to over CDP/);

    expect(connectOverCDP).not.toHaveBeenCalled();
  });

  it('names the size and the port, so the refusal is actionable', async () => {
    const err = await launchBrowser(baseConfig({ fixedViewport: MOBILE }), { port: 9222 }).catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain('390×844');
    expect(err.message).toContain('9222');
  });

  it('is NOT listed among the values CDP silently ignores', async () => {
    // The two lists must not both claim it. `incompatibleCdpConfig` is the
    // "we carried on without it" list; a refusal never gets there, and a
    // future well-meaning addition would document a warn-and-continue that
    // does not exist.
    expect(incompatibleCdpConfig(baseConfig({ fixedViewport: MOBILE }))).toEqual([]);
  });

  it('still attaches when no viewport is asked for', async () => {
    // The control: the refusal is about `fixedViewport`, not about CDP.
    const page = fakePage();
    const context = {
      pages: () => [page],
      newPage: vi.fn(async () => page),
      on: vi.fn(),
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      grantPermissions: vi.fn(async () => {}),
    };
    connectOverCDP.mockResolvedValue({
      contexts: () => [context],
      version: () => '150.0.0.0',
      close: vi.fn(async () => {}),
    });

    const session = await launchBrowser(baseConfig(), { port: 9222 });
    expect(session.cdp).toBe(true);
  });
});
