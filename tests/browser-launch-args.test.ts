/**
 * `browser.launchArgs` — SPEC-use-computer.md §5.10.
 *
 * Extra Chromium switches, APPENDED to the `--window-size` the launcher
 * already builds. The appending is the whole assertion: the first version of
 * this that anyone writes replaces the args array, and the symptom — a headed
 * window that ignores `windowSize` — surfaces nowhere near the config key that
 * caused it.
 *
 * Playwright is mocked at the module boundary, as browser-manager-viewport.ts
 * does it and for the same reason: what is under test is the argument list
 * `manager.ts` assembles, and a real launch would make this unrunnable on a
 * build machine.
 *
 * `baseConfig()` deliberately has NO `launchArgs`, so the "unchanged" case
 * below is asserted against a bare config rather than one primed with the
 * feature it is meant to prove absent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const { launchBrowser } = await import('../src/browser/manager.js');

function baseConfig(over: Partial<BrowserConfig> = {}): BrowserConfig {
  return {
    headed: false,
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

function launchFake(): void {
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
  const browser = {
    contexts: () => [context],
    newContext: vi.fn(async () => context),
    version: () => '150.0.0.0',
    close: vi.fn(async () => {}),
  };
  stealthLaunch.mockResolvedValue(browser);
  launch.mockResolvedValue(browser);
}

/** The `args` array the browser was actually launched with. */
function launchedArgs(): string[] {
  const call = (stealthLaunch.mock.calls[0] ?? launch.mock.calls[0])!;
  return (call[0] as { args: string[] }).args;
}

beforeEach(() => {
  connectOverCDP.mockReset();
  launch.mockReset();
  stealthLaunch.mockReset();
  launchFake();
});

describe('browser.launchArgs', () => {
  it('appends each arg after --window-size', async () => {
    await launchBrowser(
      baseConfig({ launchArgs: ['--disable-print-preview', '--ozone-platform=x11'] }),
    );

    const args = launchedArgs();
    expect(args[0]).toMatch(/^--window-size=/);
    expect(args).toEqual([
      '--window-size=1280,720',
      '--disable-print-preview',
      '--ozone-platform=x11',
    ]);
  });

  it('leaves the args untouched when the key is absent', async () => {
    await launchBrowser(baseConfig());

    expect(launchedArgs()).toEqual(['--window-size=1280,720']);
  });

  it('leaves the args untouched for an empty list', async () => {
    await launchBrowser(baseConfig({ launchArgs: [] }));

    expect(launchedArgs()).toEqual(['--window-size=1280,720']);
  });

  // The window size is the runner's, not the author's — an extra switch must
  // not be able to displace it, whatever order the config lists things in.
  it('does not let an extra arg replace the window size', async () => {
    await launchBrowser(
      baseConfig({ headed: true, launchArgs: ['--disable-print-preview'] }),
    );

    const args = launchedArgs();
    expect(args.filter((a) => a.startsWith('--window-size='))).toHaveLength(1);
    expect(args).toContain('--window-size=1600,1000');
    expect(args).toContain('--disable-print-preview');
  });

  // §5.10: not for CDP. An attached browser was started by someone else and
  // its command line is theirs; `connectOverCDP` takes no args at all.
  it('is not passed to a CDP attach', async () => {
    connectOverCDP.mockRejectedValue(new Error('no browser on that port'));

    await expect(
      launchBrowser(
        baseConfig({ launchArgs: ['--disable-print-preview'] }),
        { port: 9222 },
      ),
    ).rejects.toThrow();

    expect(launch).not.toHaveBeenCalled();
    expect(stealthLaunch).not.toHaveBeenCalled();
    // Whatever connectOverCDP was handed, it was not our args array.
    const arg = connectOverCDP.mock.calls[0]?.[0];
    expect(JSON.stringify(arg ?? '')).not.toContain('--disable-print-preview');
  });

  it('applies to firefox and webkit too', async () => {
    await launchBrowser(
      baseConfig({ browser: 'firefox', launchArgs: ['--marionette'] }),
    );

    expect(launchedArgs()).toEqual(['--window-size=1280,720', '--marionette']);
  });
});
