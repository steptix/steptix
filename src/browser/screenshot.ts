import type { CDPSession, Page } from 'playwright';
import { logger } from '../utils/logger.js';

export interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
}

/**
 * A PNG's real pixel size, read out of its own IHDR header.
 *
 * Bytes 16–19 and 20–23, after the 8-byte signature and the IHDR length and
 * tag. **The only trustworthy source here**, and the reason is measured: for a
 * page obtained through `chromium.connectOverCDP` — which is every CDP browser
 * this framework drives — `page.viewportSize()` returns `null`. Code that fell
 * back to a default on that null reported 1440×900 as the size of an image that
 * was really 1689×1277, and nothing downstream could tell.
 *
 * Shared by both captures so the two can never disagree about the same picture.
 */
function pngSize(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Capture a PNG screenshot and return it as base64.
 * @param page - Playwright page
 * @param fullPage - When true, captures the entire scrollable page instead of just the viewport.
 * Returns null if capture fails (non-fatal).
 */
export async function captureScreenshot(page: Page, fullPage = false): Promise<ScreenshotResult | null> {
  try {
    const buffer = await page.screenshot({
      type: 'png',
      fullPage,
    });

    // The header is read for BOTH shapes, not just the full-page one. The
    // viewport branch used to ask Playwright for the page's viewport instead,
    // which is null over CDP — see `pngSize`.
    return { base64: buffer.toString('base64'), ...pngSize(buffer) };
  } catch (err) {
    logger.warn(`Screenshot capture failed: ${String(err)}`);
    return null;
  }
}

/**
 * How long to wait for a tab's picture before giving up.
 *
 * Sized off measurement, not taste: a visible window answers in 0.4–1.1s,
 * whatever the parameters. Anything past this is the stall described on
 * `captureTabScreenshot`, and waiting longer only makes the caller wait longer
 * for the same answer.
 */
export const TAB_SCREENSHOT_TIMEOUT_MS = 15_000;

/** A tab photographed, or the reason it was not. */
export type TabScreenshot =
  | { ok: true; image: ScreenshotResult }
  | { ok: false; reason: 'timeout' | 'failed'; detail: string };

/**
 * Photograph a tab over raw CDP, for a page this framework did not open
 * (stories/cdp-tab-screenshot.md).
 *
 * **The screencast around the capture is the load-bearing part, and it was
 * measured rather than reasoned about.** A tab that is not frontmost composes
 * no new frame on its own, so `Page.captureScreenshot` waits for one that may
 * never arrive. Against real headed Chrome, capturing a background tab whose
 * page had just been changed:
 *
 * | window | plain capture | with a 1×1 screencast running |
 * | --- | --- | --- |
 * | visible, tab backgrounded | fresh, 0.6s | fresh, 0.2s |
 * | **minimized**, unchanged | **hung, 12s+** | ok, 0.2s |
 * | **minimized**, page changed | **hung, 12s+** | **fresh, 0.2s** |
 * | minimized, `captureBeyondViewport` | **hung, 12s+** | ok, 0.3s |
 *
 * `Page.startScreencast` asks the renderer for frames, which is exactly the
 * thing a hidden tab has stopped producing; at 1×1 it costs nothing and we
 * discard the frames. It is stopped immediately afterwards. Nothing about what
 * the user sees changes — unlike `Page.bringToFront`, which would photograph
 * their tab by yanking it in front of them.
 *
 * Two traps this order avoids. A capture left hung **poisons the target**:
 * Chromium serializes captures per tab, so the next one queues behind it and a
 * later request can be answered with the earlier one's image — measured, as a
 * viewport request answered with a full-page picture. And the timeout below is
 * now a backstop rather than the mechanism; it should never fire, and if it
 * does the caller is told the window is the likely cause, because that is a
 * fact about the WINDOW rather than about the page.
 *
 * Playwright's own `page.screenshot()` is not used here for a different reason:
 * its viewport path waits for a stable composited frame and times out on
 * exactly these windows. (It used to differ on dimensions too, reporting a
 * default size for a CDP page whose `viewportSize()` is null — both captures
 * now read the PNG's IHDR header through `pngSize`, so they describe the
 * picture that was actually taken.)
 *
 * Chromium-only by construction: the peek route reaches CDP browsers and
 * nothing else.
 */
export async function captureTabScreenshot(
  page: Page,
  fullPage = false,
): Promise<TabScreenshot> {
  let session: CDPSession | undefined;
  let timer: NodeJS.Timeout | undefined;
  let screencasting = false;
  try {
    session = await page.context().newCDPSession(page);
    // Wake the renderer BEFORE asking for the picture — see the table above.
    // Best-effort: if a browser will not screencast, a plain capture is still
    // worth attempting, and the timeout below is what stops that hanging.
    try {
      await session.send('Page.enable');
      await session.send('Page.startScreencast', {
        format: 'png',
        maxWidth: 1,
        maxHeight: 1,
        everyNthFrame: 1,
      });
      screencasting = true;
    } catch (err) {
      logger.warn(`Could not start the screencast that wakes a hidden tab: ${String(err)}`);
    }
    const capture = session.send('Page.captureScreenshot', {
      format: 'png',
      // No `clip`: a clip is what drags Playwright's own path into the
      // stable-frame wait. `captureBeyondViewport` renders the full scrollable
      // page off-screen, which is `full_page` exactly.
      captureBeyondViewport: fullPage,
    });
    const timedOut = Symbol('timeout');
    const shot = await Promise.race([
      capture,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), TAB_SCREENSHOT_TIMEOUT_MS);
      }),
    ]);
    if (shot === timedOut) {
      // The request is abandoned, not cancelled — CDP has no cancel. Detaching
      // in the `finally` is what stops its eventual answer mattering, and
      // swallowing that rejection is what stops it becoming an unhandled one.
      capture.catch(() => {});
      logger.warn(`Tab screenshot timed out after ${TAB_SCREENSHOT_TIMEOUT_MS}ms`);
      return {
        ok: false,
        reason: 'timeout',
        detail: `no answer within ${Math.round(TAB_SCREENSHOT_TIMEOUT_MS / 1000)}s`,
      };
    }
    return {
      ok: true,
      image: { base64: shot.data, ...pngSize(Buffer.from(shot.data, 'base64')) },
    };
  } catch (err) {
    logger.warn(`Tab screenshot capture failed: ${String(err)}`);
    return { ok: false, reason: 'failed', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
    // Stopped before the detach, and separately from it: a frame stream left
    // running on a tab the user owns is exactly the kind of thing that outlives
    // the read it was for.
    if (session && screencasting) await session.send('Page.stopScreencast').catch(() => {});
    // The attach is ours; the browser is the user's. A session left open is a
    // protocol client on their tab for the life of the process.
    if (session) await session.detach().catch(() => {});
  }
}

/**
 * Convert a base64 PNG string to a data URI for embedding in HTML.
 */
export function toDataUri(base64: string): string {
  return `data:image/png;base64,${base64}`;
}
