/**
 * issues/047 — a native JS dialog must never take the Sessions API process down.
 *
 * Playwright's server-side `DialogManager.dialogDidOpen` auto-dismisses any
 * dialog nobody subscribed to, via `dialog.close().then(() => {})` — no
 * `.catch()`. When that CDP round-trip loses to whatever already closed the
 * dialog, the rejection has no owner and Node kills the process: every session,
 * every browser, mid-run. `installDialogGuard` subscribes so that branch is
 * never reached, and answers the dialog itself with the failure caught.
 *
 * Three layers, because the bug needs all three to stay dead:
 *   - the disposition and the catch, against fakes (fast, exhaustive — and the
 *     only layer that reaches the catch on every run);
 *   - the crash race's setting, against a real browser (a cross-origin iframe
 *     torn out from under its own dialog — the shape the incident had, since
 *     the page in question hosted a Stripe payment iframe);
 *   - the wiring, so a context we own can never reach a page without a guard.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Dialog } from 'playwright';
import { closeBrowser, installDialogGuard, launchBrowser } from '../src/browser/manager.js';
import { readDevToolsPort } from '../src/browser/cdp-launcher.js';
import { addLogCallback, type LogLevel } from '../src/utils/logger.js';
import type { BrowserConfig } from '../src/config/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture every log entry for the duration of a test. */
function captureLogs(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const stop = addLogCallback((level: LogLevel, message: string) => {
    lines.push(`${level}: ${message}`);
  });
  return { lines, stop };
}

/** A `BrowserContext` with only the surface the guard touches. */
function fakeContext(): { context: BrowserContext; listeners: ((d: Dialog) => void)[] } {
  const listeners: ((d: Dialog) => void)[] = [];
  const context = {
    on(event: string, fn: (d: Dialog) => void) {
      if (event === 'dialog') listeners.push(fn);
      return this;
    },
  } as unknown as BrowserContext;
  return { context, listeners };
}

interface FakeDialogOpts {
  type?: string;
  message?: string;
  url?: string;
  /** Make the handle call reject, as a dialog that is already gone does. */
  rejectWith?: string;
}

function fakeDialog(opts: FakeDialogOpts = {}): { dialog: Dialog; calls: string[] } {
  const calls: string[] = [];
  const answer = (verb: string): Promise<void> => {
    calls.push(verb);
    return opts.rejectWith
      ? Promise.reject(new Error(opts.rejectWith))
      : Promise.resolve();
  };
  const dialog = {
    type: () => opts.type ?? 'alert',
    message: () => opts.message ?? '',
    page: () => ({ url: () => opts.url ?? 'https://example.test/' }),
    accept: () => answer('accept'),
    dismiss: () => answer('dismiss'),
  } as unknown as Dialog;
  return { dialog, calls };
}

/**
 * Settle the microtask queue and then a macrotask turn.
 *
 * Node decides a rejection is unhandled only after the turn in which it was
 * created, so a test that asserts "no unhandled rejection" has to get past
 * that point or it proves nothing.
 */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20));
}

/** Count unhandled rejections raised while `work` runs. */
async function countUnhandledRejections(work: () => Promise<void>): Promise<number> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  // Node only suppresses the fatal default while a listener is attached, so
  // this both counts and keeps the test runner alive if the guard regresses.
  process.on('unhandledRejection', onUnhandled);
  try {
    await work();
    await settle();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen.length;
}

/** Poll until `predicate` holds, or give up. Beats a fixed sleep for a race
 *  whose timing is the browser's business, not ours. */
async function waitUntil(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

const BROWSER_CONFIG: BrowserConfig = {
  headed: false,
  viewport: { width: 1280, height: 720 },
  windowSize: { width: 1280, height: 720 },
  slowMo: 0,
  browser: 'chromium',
  fullPageScreenshots: false,
  // The stealth plugin has nothing to do with dialogs and costs a second of
  // monkey-patching per launch.
  stealth: false,
};

// ---------------------------------------------------------------------------
// Disposition + the catch
// ---------------------------------------------------------------------------

describe('installDialogGuard — disposition', () => {
  let stopLogs: (() => void) | undefined;
  afterEach(() => {
    stopLogs?.();
    stopLogs = undefined;
  });

  it('subscribes on the CONTEXT, not a page', () => {
    // The distinction is the whole reach of the fix. Playwright's DialogManager
    // is context-wide, so a page-level subscription would leave every tab we do
    // not track — under CDP, that is the user's own tabs — on the unguarded
    // path.
    const { context, listeners } = fakeContext();
    installDialogGuard(context);
    expect(listeners).toHaveLength(1);
  });

  it.each(['alert', 'confirm', 'prompt'])('dismisses a %s', async (type) => {
    const { context, listeners } = fakeContext();
    installDialogGuard(context);
    const { dialog, calls } = fakeDialog({ type });

    listeners[0]!(dialog);
    await settle();

    expect(calls).toEqual(['dismiss']);
  });

  it('ACCEPTS beforeunload', async () => {
    // Mirrors Playwright's own default. Dismissing a beforeunload means "stay
    // on this page", which would silently cancel the navigation the step just
    // asked for — a behaviour change smuggled in under a crash fix.
    const { context, listeners } = fakeContext();
    installDialogGuard(context);
    const { dialog, calls } = fakeDialog({ type: 'beforeunload' });

    listeners[0]!(dialog);
    await settle();

    expect(calls).toEqual(['accept']);
  });

  it('installs once per context, so two listeners cannot fight over one dialog', () => {
    const { context, listeners } = fakeContext();
    installDialogGuard(context);
    installDialogGuard(context);
    expect(listeners).toHaveLength(1);
  });
});

describe('installDialogGuard — a failed handle is not fatal', () => {
  it('swallows a rejected dismiss instead of leaking an unhandled rejection', async () => {
    // The regression this file exists for: the production stack was exactly
    // this rejection, from `Page.handleJavaScriptDialog` on a dialog that had
    // already gone.
    const { context, listeners } = fakeContext();
    installDialogGuard(context);
    const { dialog } = fakeDialog({
      rejectWith: 'Protocol error (Page.handleJavaScriptDialog): No dialog is showing',
    });

    const unhandled = await countUnhandledRejections(async () => {
      listeners[0]!(dialog);
    });

    expect(unhandled).toBe(0);
  });

  it('swallows a rejected accept on beforeunload too', async () => {
    const { context, listeners } = fakeContext();
    installDialogGuard(context);
    const { dialog } = fakeDialog({
      type: 'beforeunload',
      rejectWith: 'Protocol error (Page.handleJavaScriptDialog): No dialog is showing',
    });

    const unhandled = await countUnhandledRejections(async () => {
      listeners[0]!(dialog);
    });

    expect(unhandled).toBe(0);
  });
});

describe('installDialogGuard — observability', () => {
  let stopLogs: (() => void) | undefined;
  afterEach(() => {
    stopLogs?.();
    stopLogs = undefined;
  });

  it('logs the type, the disposition, the page and the message', async () => {
    // Until this fix, Playwright dismissed every dialog in every run in total
    // silence — a run could be derailed by an alert nobody could see in the
    // log afterwards.
    const capture = captureLogs();
    stopLogs = capture.stop;

    const { context, listeners } = fakeContext();
    installDialogGuard(context);
    listeners[0]!(
      fakeDialog({ type: 'confirm', message: 'Delete everything?', url: 'https://shop.test/cart' })
        .dialog,
    );
    await settle();

    const line = capture.lines.find((l) => l.includes('Browser dialog'));
    expect(line).toBeDefined();
    expect(line).toContain('[confirm]');
    expect(line).toContain('dismissed');
    expect(line).toContain('https://shop.test/cart');
    expect(line).toContain('Delete everything?');
  });

  it('does not log a failed handle as an error — a vanished dialog is routine', async () => {
    const capture = captureLogs();
    stopLogs = capture.stop;

    const { context, listeners } = fakeContext();
    installDialogGuard(context);
    listeners[0]!(fakeDialog({ rejectWith: 'No dialog is showing' }).dialog);
    await settle();

    expect(capture.lines.some((l) => l.startsWith('error:'))).toBe(false);
    expect(capture.lines.some((l) => l.includes('already gone'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The real race, against a real browser
// ---------------------------------------------------------------------------

describe('installDialogGuard — the crash race, real browser', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 90_000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* noop */ }
  }, 60_000);

  it('answers the dialogs of a cross-origin iframe torn down mid-dialog, leaving nothing unhandled', async () => {
    // A dialog raised by an OOPIF blocks that renderer but NOT the parent's,
    // so the parent can remove the iframe mid-dialog and Chromium cancels the
    // dialog underneath Playwright's in-flight handle. This is the shape that
    // produced the incident's stack frame for frame.
    //
    // What it proves is that the CONTEXT guard is what answers an OOPIF's
    // dialogs through that churn — with the guard deleted, none is logged. It
    // does not prove the catch: the failing handle is the race's rare outcome
    // (measured: not once in 30 s of churn, ~20 dialogs a second), so a run
    // here almost never takes that branch. "swallows a rejected dismiss…"
    // above proves the catch, every run.
    const context = await browser.newContext();
    installDialogGuard(context);

    // Counted from the guard's OWN log line, not from a second
    // `context.on('dialog')` observer. Subscribing here would flip Playwright's
    // `hasHandlers` to true by itself, which is precisely the condition under
    // test — the test would then pass with the guard deleted, proving nothing.
    const capture = captureLogs();
    const dialogsHandled = (): number =>
      capture.lines.filter((l) => l.includes('Browser dialog')).length;
    /** Dialogs to see through the churn: a count, not a time, so a loaded
     *  machine gets as many teardowns as an idle one. */
    const DIALOGS = 20;

    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('https://child.test/')) {
        return route.fulfill({
          contentType: 'text/html',
          body: '<script>setInterval(() => alert("from the iframe"), 30);</script>',
        });
      }
      return route.fulfill({
        contentType: 'text/html',
        body:
          '<body><script>' +
          'const mk=()=>{const f=document.createElement("iframe");' +
          'f.src="https://child.test/?"+Math.random();document.body.appendChild(f);' +
          'setTimeout(()=>{f.remove();mk();},60);};mk();' +
          '</script></body>',
      });
    });

    let unhandled: number;
    try {
      const page = await context.newPage();
      unhandled = await countUnhandledRejections(async () => {
        await page.goto('https://parent.test/');
        await waitUntil(() => dialogsHandled() >= DIALOGS, 30_000);
      });
    } finally {
      capture.stop();
      await context.close().catch(() => {});
    }

    // A pass must not be the scenario silently never happening.
    expect(dialogsHandled()).toBeGreaterThanOrEqual(DIALOGS);
    expect(unhandled).toBe(0);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Wiring — every context we own is guarded
// ---------------------------------------------------------------------------

describe('launchBrowser — installs the guard on both paths', () => {
  it('guards a launched context', async () => {
    const capture = captureLogs();
    const session = await launchBrowser(BROWSER_CONFIG);
    try {
      await session.page.setContent('<body>launched</body>');
      await session.page.evaluate(() => { setTimeout(() => alert('launched dialog'), 0); });
      await waitUntil(() => capture.lines.some((l) => l.includes('Browser dialog')), 15_000);
      expect(capture.lines.some((l) => l.includes('launched dialog'))).toBe(true);
    } finally {
      capture.stop();
      await closeBrowser(session);
    }
  }, 120_000);

  it('guards a CDP-attached context', async () => {
    // The path where the blast radius is widest: the context we attach to is
    // the user's whole browser, tabs we deliberately ignore included.
    //
    // The browser picks its own debugging port and says which in
    // `DevToolsActivePort`, the way the product's CDP launcher learns it. A
    // port found free here and handed over would be free only until another
    // worker's browser or server took it first.
    //
    // Spawned, not launched through Playwright: a Playwright-launched profile
    // has a connection of its own to every page in it, with no guard — so the
    // test's own harness would race the dialog and raise the very unhandled
    // rejection this file is about.
    //
    // On Linux it passes `--no-sandbox`, as Playwright's own launch does: as
    // root in a container, or where AppArmor restricts user namespaces,
    // Chromium's sandbox cannot start and the browser aborts.
    const profileDir = mkdtempSync(path.join(os.tmpdir(), 'steptix-dialog-cdp-'));
    const cdpProcess = spawn(
      chromium.executablePath(),
      [
        '--headless',
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    // The tail of what the browser printed, for the failure message if it dies.
    let stderr = '';
    cdpProcess.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    let hasExited = false;
    const exited = new Promise<void>((resolve) =>
      cdpProcess.once('exit', () => {
        hasExited = true;
        resolve();
      }),
    );
    const capture = captureLogs();
    let session: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    try {
      await waitUntil(() => readDevToolsPort(profileDir) !== null || hasExited, 30_000);
      const port = readDevToolsPort(profileDir);
      if (port === null && hasExited) {
        throw new Error(
          `the browser exited (code ${cdpProcess.exitCode}, signal ${cdpProcess.signalCode}) ` +
            `before writing DevToolsActivePort. It printed: ${stderr.trim() || '(nothing)'}`,
        );
      }
      expect(port, 'the browser never wrote DevToolsActivePort').not.toBeNull();
      session = await launchBrowser(BROWSER_CONFIG, { port: port!, tab: 'new' });
      await session.page.setContent('<body>attached</body>');
      await session.page.evaluate(() => { setTimeout(() => alert('cdp dialog'), 0); });
      await waitUntil(() => capture.lines.some((l) => l.includes('Browser dialog')), 15_000);
      expect(capture.lines.some((l) => l.includes('cdp dialog'))).toBe(true);
    } finally {
      capture.stop();
      if (session) await closeBrowser(session);
      if (cdpProcess.exitCode === null && cdpProcess.signalCode === null) {
        cdpProcess.kill();
        await exited;
      }
      // Chromium's helper processes can hold the profile's cache files for a
      // moment after the browser process exits, so give Windows time to let
      // go — and a profile left in the temp folder is harmless, so its removal
      // never fails the test. (A run measured EBUSY on Cache_Data here.)
      await rm(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {});
    }
  }, 120_000);
});
