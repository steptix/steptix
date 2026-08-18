/**
 * `captureTabScreenshot` — the peek's own capture (stories/cdp-tab-screenshot.md).
 *
 * Every assertion here exists because the live run failed without it. The
 * screencast is not decoration: a tab that is not frontmost composes no new
 * frame, so a plain `Page.captureScreenshot` on a MINIMIZED window hangs
 * indefinitely — measured at 12s+, repeatedly, while the same call on a visible
 * window answers in 0.4s. With a 1×1 screencast running it answers in 0.2s with
 * a fresh frame. The route above this cannot tell any of that apart, so it is
 * pinned where it is decided.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright';
import { captureTabScreenshot, TAB_SCREENSHOT_TIMEOUT_MS } from '../src/browser/screenshot.js';

/** A PNG's first 24 bytes carry the signature, the IHDR length and tag, then
 *  width and height — which is where the real dimensions are read from. */
function pngHeader(width: number, height: number): string {
  const buf = Buffer.alloc(24);
  buf.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buf.write('IHDR', 12, 'binary');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}

interface FakeSession {
  send: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  calls: string[];
}

function fakePage(
  opts: {
    /** What `Page.captureScreenshot` does. Defaults to a 800×600 PNG. */
    capture?: () => Promise<{ data: string }>;
    /** Make the screencast unavailable, as an engine that lacks it would. */
    screencastThrows?: boolean;
    newSessionThrows?: boolean;
  } = {},
): { page: Page; session: FakeSession } {
  const calls: string[] = [];
  const session: FakeSession = {
    calls,
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string) => {
      calls.push(method);
      if (method === 'Page.startScreencast' && opts.screencastThrows) {
        throw new Error('Page.startScreencast is not available');
      }
      if (method === 'Page.captureScreenshot') {
        return opts.capture ? await opts.capture() : { data: pngHeader(800, 600) };
      }
      return {};
    }),
  };
  const page = {
    context: () => ({
      newCDPSession: async () => {
        if (opts.newSessionThrows) throw new Error('no CDP here');
        return session;
      },
    }),
  } as unknown as Page;
  return { page, session };
}

describe('captureTabScreenshot wakes the tab before photographing it', () => {
  it('starts a 1x1 screencast BEFORE the capture and stops it after', async () => {
    const { page, session } = fakePage();

    const result = await captureTabScreenshot(page);

    expect(result.ok).toBe(true);
    // Order is the whole point: a screencast started after the capture would
    // wake a renderer that has already been asked for a frame it will not give.
    expect(session.calls).toEqual([
      'Page.enable',
      'Page.startScreencast',
      'Page.captureScreenshot',
      'Page.stopScreencast',
    ]);
    // Tiny on purpose — the frames are discarded, only the waking matters.
    const screencastArgs = session.send.mock.calls.find(
      (c) => c[0] === 'Page.startScreencast',
    )?.[1] as { maxWidth: number; maxHeight: number };
    expect(screencastArgs.maxWidth).toBe(1);
    expect(screencastArgs.maxHeight).toBe(1);
  });

  it('leaves nothing running on a tab the user owns', async () => {
    const { page, session } = fakePage();

    await captureTabScreenshot(page);

    // A frame stream or a protocol client outliving the read is exactly the
    // kind of thing a "changes nothing" verb must not do.
    expect(session.calls).toContain('Page.stopScreencast');
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it('asks for the viewport by default and the whole page for full_page', async () => {
    const { page, session } = fakePage();

    await captureTabScreenshot(page);
    expect(session.send).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });

    await captureTabScreenshot(page, true);
    expect(session.send).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
  });

  it('reads the real dimensions out of the PNG, not off the page', async () => {
    // `page.viewportSize()` returns null for a CDP-attached page, so the run
    // pipeline's helper reports DEFAULT_BROWSER_DIMENSIONS — 1440×900 — for an
    // image that is nothing of the sort. That reached a live result before this
    // test existed.
    const { page } = fakePage({ capture: async () => ({ data: pngHeader(1689, 1277) }) });

    const result = await captureTabScreenshot(page);

    expect(result).toEqual({
      ok: true,
      image: { base64: pngHeader(1689, 1277), width: 1689, height: 1277 },
    });
  });

  it('still tries the capture when the screencast cannot be started', async () => {
    // Best-effort: a browser that will not screencast can still be photographed
    // when its window is on screen, and the timeout is what stops that hanging.
    const { page, session } = fakePage({ screencastThrows: true });

    const result = await captureTabScreenshot(page);

    expect(result.ok).toBe(true);
    expect(session.calls).toContain('Page.captureScreenshot');
    // Not stopped, because it never started.
    expect(session.calls).not.toContain('Page.stopScreencast');
    expect(session.detach).toHaveBeenCalledTimes(1);
  });
});

describe('captureTabScreenshot answers rather than hanging', () => {
  it('gives up after the budget and says the wait was the problem', async () => {
    vi.useFakeTimers();
    try {
      const { page, session } = fakePage({
        // Never resolves — the measured minimized-window behaviour.
        capture: () => new Promise<{ data: string }>(() => {}),
      });

      const pending = captureTabScreenshot(page);
      await vi.advanceTimersByTimeAsync(TAB_SCREENSHOT_TIMEOUT_MS + 100);
      const result = await pending;

      expect(result).toEqual({
        ok: false,
        reason: 'timeout',
        detail: `no answer within ${Math.round(TAB_SCREENSHOT_TIMEOUT_MS / 1000)}s`,
      });
      // The abandoned request is not cancellable — CDP has no cancel — so the
      // detach is what stops its eventual answer mattering.
      expect(session.detach).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a thrown capture as a failure, with the reason', async () => {
    const { page } = fakePage({
      capture: async () => {
        throw new Error('Target closed');
      },
    });

    const result = await captureTabScreenshot(page);

    expect(result).toEqual({ ok: false, reason: 'failed', detail: 'Target closed' });
  });

  it('reports a session that could not be opened as a failure, not a timeout', async () => {
    // Different remedies: a timeout says "your window", a failure says "your
    // browser". Collapsing them sends someone to the wrong one.
    const { page } = fakePage({ newSessionThrows: true });

    const result = await captureTabScreenshot(page);

    expect(result).toMatchObject({ ok: false, reason: 'failed' });
  });
});
