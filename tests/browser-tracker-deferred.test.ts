/**
 * `BrowserTracker`'s unlaunched state — SPEC-use-computer.md §4.6.
 *
 * The tracker is the piece that makes "the browser launches at the first
 * browser-surface step" expressible at all, so this file is about the tracker
 * on its own: no server, no runner, no Playwright. `launchBrowser` never runs
 * here; the launcher is a counting closure, which is the only way to assert
 * the two properties that matter — that it runs EXACTLY once under concurrent
 * callers, and that a FAILED launch is not remembered.
 *
 * The eager constructor is exercised alongside, because the whole point of
 * keeping it is that callers already holding a session (the errand runner,
 * every other test) are untouched.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  BrowserTracker,
  NoBrowserLaunchedError,
  NO_BROWSER_LAUNCHED_MESSAGE,
  type BrowserSession,
} from '../src/browser/manager.js';

/** The least session the tracker will accept — it only ever stores it. */
function fakeSession(label = 'a'): BrowserSession {
  const page = { url: () => `https://example.com/${label}` };
  return {
    browser: { close: vi.fn(async () => {}), isConnected: () => true },
    context: { close: vi.fn(async () => {}) },
    page,
    pageTracker: { getActive: () => page },
    engine: 'chromium',
    channel: 'chrome',
  } as unknown as BrowserSession;
}

describe('BrowserTracker.deferred — nothing launches until it is asked', () => {
  it('does not call the launcher when the tracker is created', () => {
    const launch = vi.fn(async () => fakeSession());

    const tracker = BrowserTracker.deferred(launch);

    expect(launch).not.toHaveBeenCalled();
    expect(tracker.hasActive()).toBe(false);
    expect(tracker.isLaunched()).toBe(false);
    expect(tracker.count).toBe(0);
  });

  it('launches once on ensureLaunched, and hasActive flips false → true', async () => {
    const session = fakeSession();
    const launch = vi.fn(async () => session);
    const tracker = BrowserTracker.deferred(launch);

    expect(tracker.hasActive()).toBe(false);
    const launched = await tracker.ensureLaunched();

    expect(launched).toBe(session);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(tracker.hasActive()).toBe(true);
    expect(tracker.getActive()).toBe(session);
    expect(tracker.getActiveLabel()).toBe('default');
  });

  it('runs the launcher once for a second, later ensureLaunched', async () => {
    const launch = vi.fn(async () => fakeSession());
    const tracker = BrowserTracker.deferred(launch);

    const first = await tracker.ensureLaunched();
    const second = await tracker.ensureLaunched();

    expect(launch).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  // The step boundary is not the only caller in flight: a batch can be queued
  // behind another, and a future `[use browser]` switch asks the same question.
  // Two callers arriving before the first launch resolves must SHARE it — two
  // browser windows for one session would be the visible failure.
  it('shares one in-flight launch between concurrent callers', async () => {
    let resolve!: (s: BrowserSession) => void;
    const session = fakeSession();
    const launch = vi.fn(
      () => new Promise<BrowserSession>((r) => { resolve = r; }),
    );
    const tracker = BrowserTracker.deferred(launch);

    const a = tracker.ensureLaunched();
    const b = tracker.ensureLaunched();
    const c = tracker.ensureLaunched();
    resolve(session);

    expect(await a).toBe(session);
    expect(await b).toBe(session);
    expect(await c).toBe(session);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(tracker.count).toBe(1);
  });

  // A rejection that stuck would turn one bad moment — a channel briefly
  // unavailable, a profile locked by a browser still shutting down — into a
  // session that can never open a browser again.
  it('does not cache a failed launch: the next call retries', async () => {
    const session = fakeSession();
    const launch = vi
      .fn<() => Promise<BrowserSession>>()
      .mockRejectedValueOnce(new Error('chrome is not installed'))
      .mockResolvedValueOnce(session);
    const tracker = BrowserTracker.deferred(launch);

    await expect(tracker.ensureLaunched()).rejects.toThrow('chrome is not installed');
    expect(tracker.hasActive()).toBe(false);
    expect(tracker.isLaunched()).toBe(false);

    await expect(tracker.ensureLaunched()).resolves.toBe(session);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(tracker.hasActive()).toBe(true);
  });

  it('rejects every concurrent waiter on one failed launch', async () => {
    const launch = vi.fn(async () => {
      throw new Error('EADDRINUSE');
    });
    const tracker = BrowserTracker.deferred(launch);

    const a = tracker.ensureLaunched();
    const b = tracker.ensureLaunched();

    await expect(a).rejects.toThrow('EADDRINUSE');
    await expect(b).rejects.toThrow('EADDRINUSE');
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe('BrowserTracker — what an unlaunched tracker answers', () => {
  // The distinction this asserts is the whole reason for the new error: the
  // old sentence blames `closeBrowser`, and an author who never wrote one
  // would go looking for a step that does not exist.
  it('getActive() throws the never-launched error, not the closeBrowser one', () => {
    const tracker = BrowserTracker.deferred(async () => fakeSession());

    expect(() => tracker.getActive()).toThrow(NoBrowserLaunchedError);
    expect(() => tracker.getActive()).toThrow(NO_BROWSER_LAUNCHED_MESSAGE);
    expect(() => tracker.getActive()).not.toThrow(/closeBrowser/);
  });

  it('keeps the closeBrowser message for a tracker emptied by closeBrowser', async () => {
    const tracker = new BrowserTracker(fakeSession());

    await tracker.close('default');

    expect(() => tracker.getActive()).toThrow(/closeBrowser left zero browsers/);
    expect(() => tracker.getActive()).not.toThrow(NoBrowserLaunchedError);
  });

  it('closeAll() over an unlaunched tracker is a no-op', async () => {
    const launch = vi.fn(async () => fakeSession());
    const tracker = BrowserTracker.deferred(launch);

    await expect(tracker.closeAll()).resolves.toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
    expect(tracker.count).toBe(0);
  });

  it('list() and all() are empty rather than throwing', () => {
    const tracker = BrowserTracker.deferred(async () => fakeSession());

    expect(tracker.all()).toEqual([]);
    expect(tracker.list()).toEqual([]);
    expect(tracker.has('default')).toBe(false);
  });

  it('switchTo("default") before any launch says so, rather than "known: "', () => {
    const tracker = BrowserTracker.deferred(async () => fakeSession());

    expect(() => tracker.switchTo('default')).toThrow(NoBrowserLaunchedError);
    // An unknown label is still an unknown label.
    expect(() => tracker.switchTo('admin')).toThrow(/No browser registered as "admin"/);
  });
});

describe('BrowserTracker — openBrowser in a session that never launched', () => {
  // §4.6: `add()` pushes and promotes, exactly as it always did. The deferred
  // `default` is still owed, and a later browser-surface step gets it.
  it('add() works on an unlaunched tracker and promotes the new browser', async () => {
    const opened = fakeSession('opened');
    const tracker = BrowserTracker.deferred(async () => fakeSession('default'));

    tracker.add('admin', opened);

    expect(tracker.hasActive()).toBe(true);
    expect(tracker.getActive()).toBe(opened);
    expect(tracker.getActiveLabel()).toBe('admin');
    expect(tracker.count).toBe(1);
  });

  it('a later ensureLaunched still opens the default without stealing focus', async () => {
    const opened = fakeSession('opened');
    const def = fakeSession('default');
    const tracker = BrowserTracker.deferred(async () => def);

    tracker.add('admin', opened);
    const launched = await tracker.ensureLaunched();

    expect(launched).toBe(def);
    expect(tracker.count).toBe(2);
    expect(tracker.has('default')).toBe(true);
    // Still on the browser the author named — a lazy launch is not a switch.
    expect(tracker.getActiveLabel()).toBe('admin');
    expect(tracker.switchTo('default')).toBe(def);
  });
});

describe('BrowserTracker — the eager constructor is unchanged', () => {
  it('is launched from the start and ensureLaunched is a no-op', async () => {
    const session = fakeSession();
    const tracker = new BrowserTracker(session);

    expect(tracker.hasActive()).toBe(true);
    expect(tracker.isLaunched()).toBe(true);
    expect(tracker.getActive()).toBe(session);
    expect(await tracker.ensureLaunched()).toBe(session);
  });
});
