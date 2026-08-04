import { describe, it, expect, vi } from 'vitest';
import { BrowserTracker, closeBrowser } from '../src/browser/manager.js';
import type { BrowserSession } from '../src/browser/manager.js';

// ---------------------------------------------------------------------------
// stories/mcp-cdp-browser.md §8 — tearing a session down must never destroy a
// CDP browser, and must not leave the tab the test opened behind.
//
// The spec asked for "a test asserts a CDP session never enters
// BrowserTracker". That assertion could not be written, because it is not
// true: `new BrowserTracker(initialSession)` takes whatever the session is,
// CDP or not, on BOTH the CLI and server paths. What issues/006 actually
// observed is narrower — the CLI test-runner's `finally` special-cases
// `initialSession.cdp` and so never *closes* a CDP session through the
// tracker. `SessionManager.closeSession` has no such special case.
//
// So these tests pin the invariant that argument was protecting, at the level
// it is actually observable: whatever teardown route is taken, the browser
// survives and no tab is orphaned.
// ---------------------------------------------------------------------------

function fakeSession(over: Partial<BrowserSession> = {}): BrowserSession & {
  calls: string[];
} {
  const calls: string[] = [];
  const session = {
    calls,
    browser: {
      close: vi.fn(async () => {
        calls.push('browser.close');
      }),
      isConnected: () => true,
    },
    context: {
      close: vi.fn(async () => {
        calls.push('context.close');
      }),
    },
    page: {
      close: vi.fn(async () => {
        calls.push('page.close');
      }),
    },
    pageTracker: {},
    ...over,
  };
  return session as unknown as BrowserSession & { calls: string[] };
}

describe('closeBrowser on a CDP session', () => {
  it('never closes the context — that is the whole point of CDP teardown', async () => {
    const session = fakeSession({ cdp: true });
    await closeBrowser(session);
    expect(session.calls).not.toContain('context.close');
  });

  it('severs the connection only, leaving the browser process running', async () => {
    const session = fakeSession({ cdp: true });
    await closeBrowser(session);
    expect(session.calls).toEqual(['browser.close']);
  });

  it('closes the tab it opened, and only that one', async () => {
    const opened = fakeSession({ cdp: true, cdpTabOpenedByUs: true });
    await closeBrowser(opened);
    expect(opened.calls).toEqual(['page.close', 'browser.close']);

    // A tab the user already had is theirs, and stays theirs.
    const attached = fakeSession({ cdp: true, cdpTabOpenedByUs: false });
    await closeBrowser(attached);
    expect(attached.calls).not.toContain('page.close');
  });

  it('closes context and browser for a non-CDP session, as before', async () => {
    const session = fakeSession({ cdp: false });
    await closeBrowser(session);
    expect(session.calls).toEqual(['context.close', 'browser.close']);
  });
});

describe('BrowserTracker teardown routes through closeBrowser (issues/006)', () => {
  it('closeAll does not close the context of a CDP session', async () => {
    // Before the fix this called `context.close()` + `browser.close()`
    // directly. Both are verified no-ops against a real connectOverCDP
    // connection, so nothing was being destroyed — but neither knew about
    // `cdpTabOpenedByUs`, so the tab the test opened was left behind on every
    // run. That is the leak this routing closes.
    const session = fakeSession({ cdp: true, cdpTabOpenedByUs: true });
    await new BrowserTracker(session).closeAll();
    expect(session.calls).toEqual(['page.close', 'browser.close']);
  });

  it('close(label) does not close the context of a CDP session either', async () => {
    const session = fakeSession({ cdp: true, cdpTabOpenedByUs: true });
    await new BrowserTracker(session, 'default').close('default');
    expect(session.calls).toEqual(['page.close', 'browser.close']);
  });

  it('is unchanged for the non-CDP sessions that already went through it', async () => {
    const session = fakeSession({ cdp: false });
    await new BrowserTracker(session).closeAll();
    expect(session.calls).toEqual(['context.close', 'browser.close']);
  });

  it('closes every tracked browser, not only the first', async () => {
    const first = fakeSession({ cdp: false });
    const second = fakeSession({ cdp: true, cdpTabOpenedByUs: true });
    const tracker = new BrowserTracker(first);
    tracker.add('second', second);

    await tracker.closeAll();

    expect(first.calls).toEqual(['context.close', 'browser.close']);
    expect(second.calls).toEqual(['page.close', 'browser.close']);
  });

  it('keeps going when one browser throws on teardown', async () => {
    const bad = fakeSession({ cdp: false });
    (bad.context.close as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('already gone'));
    const good = fakeSession({ cdp: false });
    const tracker = new BrowserTracker(bad);
    tracker.add('good', good);

    await expect(tracker.closeAll()).resolves.toBeUndefined();
    expect(good.calls).toContain('browser.close');
  });
});
