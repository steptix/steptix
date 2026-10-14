/**
 * A model capture goes ahead only once every frame's hide has LANDED, or the
 * ring's own lifetime has passed (docs/specs/SPEC-interaction-highlight.md
 * §16.6; review round 3, item 1).
 *
 * `page.screenshot` waits for frames, so a late hide happened to be safe
 * there; the raw-CDP tab peek and `[use computer]`'s screen grab do not, and
 * a busy cross-origin frame keeps showing its last painted frame, ring and
 * all. The stall here is deterministic: a fake frame whose `evaluate` lands
 * only when the test lets it, with fake timers standing in for the budget —
 * no browser, and nothing waits on the wall clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Page } from 'playwright';

type Highlight = typeof import('../src/browser/highlight.js');
/** A fresh module per test: "a ring is up somewhere in this process" is
 *  module state, and one test's ring must not make the next one wait. */
let H: Highlight;

beforeEach(async () => {
  vi.resetModules();
  H = await import('../src/browser/highlight.js');
});

afterEach(() => {
  vi.useRealTimers();
});

/** A page with one frame whose `hide` / `end` evaluations land only on
 *  `release()`; a restore lands at once. Every call is recorded in order.
 *  `navigate` changes the frame's address the way `pushState` or a hash
 *  change does: same frame, new URL. `context` stands in for the page's
 *  browser context, for the CDP target-id lookup. `setHost` says whether
 *  the frame answers that a Steptix host is still there (the real
 *  `onRegistry` answer), and `ours` records, per call, whether it was sent
 *  with a ring of ours known to be up or coming. */
function stalledPage(context?: () => unknown): {
  page: Page;
  calls: string[];
  release: () => void;
  navigate: (url: string) => void;
  setHost: (present: boolean) => void;
  ours: boolean[];
} {
  const calls: string[] = [];
  const ours: boolean[] = [];
  let host = false;
  let url = 'https://app.test/';
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const frame = {
    isDetached: () => false,
    url: () => url,
    evaluate: vi.fn(async (_fn: unknown, args?: { method: string; ours?: boolean }) => {
      calls.push(args?.method ?? 'probe');
      ours.push(args?.ours === true);
      if (args?.method === 'hide' || args?.method === 'end') await held;
      if (args?.method === 'end') host = false;
      return host;
    }),
  };
  const page = {
    frames: () => [frame],
    mainFrame: () => frame,
    on: () => {},
    off: () => {},
    ...(context !== undefined && { context }),
  } as unknown as Page;
  return {
    page,
    calls,
    release,
    navigate: (to) => { url = to; },
    setHost: (present) => { host = present; },
    ours,
  };
}

/**
 * Stamp "a ring of ours is up on `page` until `until`" the way a draw does.
 * With `drewIn`, the draw answers which document drew (a frame that HELD a
 * ring); without it, a frame that never did.
 */
function ringOn(page: Page, until: number, drewIn?: string): void {
  const answer = drewIn === undefined ? 1 : { drawn: 1, href: drewIn };
  const locator = { page: () => page, evaluateAll: async () => answer, first: () => locator };
  H.createHighlighter({ ...H.HIGHLIGHT_DEFAULTS, durationMs: until - 1_000 }, { now: () => 0 }) // the 1 s margin makes it end at `until`
    .mark(locator as never, 'act');
}

describe('a model capture waits for every hide to land', () => {
  it('past the budget, the picture waits; once the hide lands, it is taken', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, calls, release } = stalledPage();
    ringOn(page, 1e15);
    let shot = false;
    const capture = H.hiddenFor(page, async () => {
      shot = true;
      return 'picture';
    }, { now: () => 0 });
    // Well past the 500 ms budget: the hide has not landed, the ring is
    // still up on its clock, so no picture yet.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(shot).toBe(false);
    release();
    await expect(capture).resolves.toBe('picture');
    expect(calls).toEqual(['hide', 'restore']);
  });

  it('a hide that never lands while the ring may still be up gives no picture', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page } = stalledPage();
    ringOn(page, 1e15);
    let shot = false;
    const capture = H.hiddenFor(page, async () => {
      shot = true;
      return 'picture';
    }, { now: () => 0 });
    const outcome = expect(capture).rejects.toBeInstanceOf(H.RingsNotHiddenError);
    await vi.advanceTimersByTimeAsync(20_000);
    await outcome;
    expect(shot).toBe(false);
  });

  it('a frame that never drew our ring: once the ring\'s lifetime has passed, the picture goes ahead', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page } = stalledPage();
    let clock = 0;
    ringOn(page, 3_000);
    const capture = H.hiddenFor(page, async () => 'picture', { now: () => clock });
    clock = 5_000; // the ring has faded by now
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(capture).resolves.toBe('picture');
  });

  it('a frame that DREW our ring: its hide is waited for until the ring\'s lifetime, and past it the picture goes ahead (§16.9)', async () => {
    // The ring's visibility runs on the compositor, so a busy frame shows
    // nothing of it after its lifetime. Round 4 refused this picture: the
    // fade then ran on the main thread and froze with it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page } = stalledPage();
    let clock = 0;
    ringOn(page, 3_000, 'https://app.test/');
    await vi.advanceTimersByTimeAsync(0); // the draw's answer, with its frame, lands
    let shot = false;
    const capture = H.hiddenFor(page, async () => {
      shot = true;
      return 'picture';
    }, { now: () => clock });
    // Well past the 500 ms budget, the hide has not landed and the ring is
    // still within its lifetime: no picture yet.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(shot).toBe(false);
    clock = 5_000; // past the ring's lifetime
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(capture).resolves.toBe('picture');
    expect(shot).toBe(true);
  });

  it('a frame that drew our ring: once its hide lands, the picture is taken, lifetime or not', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, release } = stalledPage();
    let clock = 0;
    ringOn(page, 3_000, 'https://app.test/');
    await vi.advanceTimersByTimeAsync(0);
    const capture = H.hiddenFor(page, async () => 'picture', { now: () => clock });
    clock = 5_000;
    await vi.advanceTimersByTimeAsync(8_000);
    release();
    await expect(capture).resolves.toBe('picture');
  });

  it('endRings resolves only when the end has landed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, release } = stalledPage();
    ringOn(page, 1e15);
    let done = false;
    const ended = H.endRings([page], { now: () => 0 }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(done).toBe(false);
    release();
    await ended;
    expect(done).toBe(true);
  });
});

describe('a frame that drew is held by its Frame, not its address (review round 5, item 1)', () => {
  for (const [name, to] of [
    ['pushState', 'https://app.test/checkout'],
    ['a hash change', 'https://app.test/#paid'],
  ] as const) {
    it(`after ${name}, an end still gives the frame that drew its grace past the ring's lifetime`, async () => {
      // A frame taken for one that never drew would be let go as soon as the
      // ring's lifetime had passed (500 ms here); the frame that drew is
      // given the 2 s grace.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { page, navigate } = stalledPage();
      ringOn(page, 3_000, 'https://app.test/');
      await vi.advanceTimersByTimeAsync(0); // the draw's answer, with its frame, lands
      navigate(to); // an SPA router after the click: same frame, new address
      let done = false;
      const ended = H.endRings([page], { now: () => 5_000 }).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1_100);
      await ended;
      expect(done).toBe(true);
    });
  }
});

describe('a target-id lookup that never answers (review round 5, item 2)', () => {
  it('costs a capture a bounded wait, not the capture', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // A page connected over CDP whose attach never answers: a tab whose
    // main thread is busy, a browser that stopped answering.
    const browser = { on: () => {} };
    H.registerCdpBrowser(browser, 'localhost:9222');
    const { page, release } = stalledPage(() => ({ browser: () => browser, newCDPSession: () => new Promise(() => {}) }));
    release(); // every frame answers at once; only the lookup hangs
    ringOn(page, 1e15);
    let done = false;
    const capture = H.hiddenFor(page, async () => 'picture', { now: () => 0 }).then((picture) => {
      done = true;
      return picture;
    });
    // The pending record's lookup, then this page's own: a second each.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(done).toBe(true);
    await expect(capture).resolves.toBe('picture');
    // The lookup is still out: the next capture does not wait for it again.
    let again = false;
    void H.hiddenFor(page, async () => 'picture', { now: () => 0 }).then(() => {
      again = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(again).toBe(true);
  });
});

describe('[use computer] does not stall on a frame a modal holds (review round 5, item 3)', () => {
  it('an end waits for a frame that drew only until its ring\'s lifetime and a grace, and says so at debug', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { logger } = await import('../src/utils/logger.js');
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      const { page } = stalledPage();
      ringOn(page, 3_000, 'https://app.test/');
      await vi.advanceTimersByTimeAsync(0); // the draw's answer, with its frame, lands
      let done = false;
      const ended = H.endRings([page], { now: () => 0 }).then(() => {
        done = true;
      });
      // The ring lives until 3 s on this clock; the grace is 2 s on top.
      await vi.advanceTimersByTimeAsync(4_900);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await ended;
      expect(done).toBe(true);
      expect(debug.mock.calls.some(([message]) => String(message).includes('did not answer the end'))).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });

  it('a frame the end could not reach stays in the record: the next end gives it its grace again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page } = stalledPage();
    ringOn(page, 3_000, 'https://app.test/');
    await vi.advanceTimersByTimeAsync(0);
    const first = H.endRings([page], { now: () => 5_000 });
    await vi.advanceTimersByTimeAsync(2_100);
    await first;
    let done = false;
    const again = H.endRings([page], { now: () => 5_000 }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    await again;
    expect(done).toBe(true);
  });
});

// ── Review round 6 ───────────────────────────────────────────────────────────

/** A mark whose draw answers only when the test says, with `answer`. */
function drawOnItsWay(page: Page): { answer: (href?: string) => void } {
  let answer: (href?: string) => void = () => {};
  const answered = new Promise<unknown>((resolve) => {
    answer = (href) => resolve(href === undefined ? 0 : { drawn: 1, href });
  });
  const locator = { page: () => page, evaluateAll: () => answered, first: () => locator };
  H.createHighlighter({ ...H.HIGHLIGHT_DEFAULTS, durationMs: 2_000 }, { now: () => 0 }).mark(locator as never, 'act');
  return { answer };
}

describe('the frame decides when its entry goes, not the clock (review round 6, H1)', () => {
  it('a frame that still has a Steptix host after the lifetime keeps its entry, so the next capture still hides', async () => {
    // A frame that blocked before the ring's first paint starts the ring when
    // it unblocks, and shows it for a whole duration from then: on our clock
    // it is over, in the page it is not.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, calls, release, setHost } = stalledPage();
    release();
    setHost(true);
    ringOn(page, 3_000, 'https://app.test/');
    await vi.advanceTimersByTimeAsync(0); // the draw's answer, with its frame, lands
    expect(await H.hiddenFor(page, async () => 'first', { now: () => 5_000 })).toBe('first');
    calls.length = 0;
    expect(await H.hiddenFor(page, async () => 'second', { now: () => 5_000 })).toBe('second');
    expect(calls).toEqual(['hide', 'restore']);
    // The ring retires and its host goes: the next capture asks once more,
    // hears that nothing is left, and the one after asks nothing.
    setHost(false);
    await H.hiddenFor(page, async () => 'third', { now: () => 5_000 });
    calls.length = 0;
    expect(await H.hiddenFor(page, async () => 'fourth', { now: () => 5_000 })).toBe('fourth');
    expect(calls).toEqual([]);
  });

  it('the page\'s own confirmation after the ring asks again while the host is there, and drops the entry once it is gone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Due at the ring's lifetime, it asks the frame that drew; a host still
    // there keeps the entry.
    const { page: late, calls: lateCalls, release: lateRelease, setHost: lateHost } = stalledPage();
    lateRelease();
    lateHost(true);
    let clock = 0;
    const answer = { drawn: 1, href: 'https://app.test/' };
    const locator = { page: () => late, evaluateAll: async () => answer, first: () => locator };
    H.createHighlighter({ ...H.HIGHLIGHT_DEFAULTS, durationMs: 2_000 }, { now: () => clock }).mark(locator as never, 'act');
    await vi.advanceTimersByTimeAsync(0);
    clock = 3_000;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(lateCalls.filter((c) => c === 'probe')).toHaveLength(1);
    lateCalls.length = 0;
    expect(await H.hiddenFor(late, async () => 'shot', { now: () => clock })).toBe('shot');
    expect(lateCalls).toContain('hide');
    lateHost(false);
    await vi.advanceTimersByTimeAsync(1_000); // the retry after a second
    lateCalls.length = 0;
    expect(await H.hiddenFor(late, async () => 'shot', { now: () => clock })).toBe('shot');
    expect(lateCalls).toEqual([]);
  });
});

describe('a draw on its way counts as a ring of ours (review round 6, H2)', () => {
  it('a capture while a draw is unanswered hides with a ring of ours coming, whatever the clock says', async () => {
    // An act whose handler blocks: the draw it was marked with is queued
    // behind the handler, and the model capture after the act comes first.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, calls, ours, release } = stalledPage();
    release();
    const { answer } = drawOnItsWay(page);
    // Far past the pre-draw stamp's lifetime on the capture's clock.
    expect(await H.hiddenFor(page, async () => 'shot', { now: () => 60_000 })).toBe('shot');
    expect(calls).toEqual(['hide', 'restore']);
    expect(ours[0]).toBe(true); // the entry is written even with no host yet
    answer();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('while the draw is unanswered, a hide that does not land gives no picture, with no escape on the clock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page } = stalledPage(); // hides never land
    drawOnItsWay(page);
    const capture = H.hiddenFor(page, async () => 'picture', { now: () => 60_000 });
    const outcome = expect(capture).rejects.toBeInstanceOf(H.RingsNotHiddenError);
    await vi.advanceTimersByTimeAsync(20_000);
    await outcome;
  });

  it('endRings waits for an unanswered draw before it ends the rings', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, calls, release } = stalledPage();
    release();
    const { answer } = drawOnItsWay(page);
    let done = false;
    const ended = H.endRings([page], { now: () => 60_000 }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(done).toBe(false);
    expect(calls).not.toContain('end');
    answer('https://app.test/'); // the draw lands, and builds its host
    await vi.advanceTimersByTimeAsync(0);
    await ended;
    expect(calls).toContain('end');
  });
});

describe('with the highlight off, nothing runs (review round 6)', () => {
  it('a model capture of a page nothing drew on asks no frame and no browser', async () => {
    const context = vi.fn(() => ({ newCDPSession: vi.fn() }));
    const { page, calls } = stalledPage(context);
    expect(await H.hiddenFor(page, async () => 'shot')).toBe('shot');
    await H.endRings([page]);
    expect(calls).toEqual([]);
    expect(context).not.toHaveBeenCalled();
  });
});

describe('the page\'s own confirmation gives up on a host that never goes (review round 7)', () => {
  it('asks once when the ring is due, then retries after 1 s doubling to 30 s, ten times, and never after', async () => {
    // A page that keeps the host for good: one that pauses animations, say.
    // Its own captures keep asking; the background confirmation stops.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, calls, release, setHost } = stalledPage();
    release();
    setHost(true);
    let clock = 0;
    const answer = { drawn: 1, href: 'https://app.test/' };
    const locator = { page: () => page, evaluateAll: async () => answer, first: () => locator };
    H.createHighlighter({ ...H.HIGHLIGHT_DEFAULTS, durationMs: 2_000 }, { now: () => clock }).mark(locator as never, 'act');
    await vi.advanceTimersByTimeAsync(0); // the draw lands: due at 3 s
    clock = 10_000; // past the ring's lifetime from here on
    const probes = (): number => calls.filter((c) => c === 'probe').length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(probes()).toBe(1);
    // 1 + 2 + 4 + 8 + 16 + 30 × 5 = 181 s of retries.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(probes()).toBe(11);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(probes()).toBe(11);
  });
});

// ── Other Page objects on one tab (§4.3 rules 9 and 10, review 17) ──────────

/** A fake CDP connection to `endpoint`, registered the way
 *  `connectOverCdpSession` registers its Browser. */
function cdpConnection(endpoint: string): { browser: object; disconnect: () => void } {
  const listeners: Array<() => void> = [];
  const browser = {
    on: (event: string, fn: () => void) => {
      if (event === 'disconnected') listeners.push(fn);
    },
  };
  H.registerCdpBrowser(browser, endpoint);
  return { browser, disconnect: () => listeners.forEach((fn) => fn()) };
}

/**
 * A fake Page on tab `targetId` through `connection` (or a launched browser
 * when `connection` is null), with a main frame and a child frame, each
 * answering whether a Steptix host is there (`host`). `lookups` counts its
 * target-id lookups (each one a CDP attach in a real browser).
 */
interface TabPageOptions {
  /** The tab's hosts, shared by every Page on it; each Page its own when absent. */
  host?: { main: boolean; child: boolean };
  /** The child frame's address as this Page sees it ('' for a cross-site
   *  frame that loaded before the attach). */
  childUrl?: string;
  /** Resolves when this Page's target-id lookup may answer (never, to model
   *  a lookup that outruns its budget). */
  lookup?: () => Promise<void>;
  /** While it returns a promise, the child frame's answers wait for it, and
   *  answer what the frame held when asked. */
  childGate?: () => Promise<void> | undefined;
  /** The tabs alive in the browser, for `Target.getTargets`. */
  alive?: () => string[];
  /** The child frame is in a renderer process of its own (it has a CDP
   *  session); otherwise Playwright refuses one for it. */
  childOutOfProcess?: boolean;
  /** 'never': looking up the child's <iframe> element never answers (a parent
   *  busy for longer than the budget). */
  childElement?: 'never';
}

function tabPage(connection: { browser: object } | null, targetId = 'tab-1', options: TabPageOptions = {}): {
  page: Page;
  calls: string[];
  host: { main: boolean; child: boolean };
  lookups: () => number;
  close: () => void;
  /** Detach the child frame, as Playwright's `framedetached` says. */
  detachChild: () => void;
  /** The child's <iframe> element handle, once looked up. */
  childElementDisposed: () => boolean;
} {
  const calls: string[] = [];
  const host = options.host ?? { main: false, child: false };
  const listeners: Array<() => void> = [];
  const detachedListeners: Array<(frame: unknown) => void> = [];
  let elementDisposed = false;
  let closed = false;
  let lookups = 0;
  const frame = (name: 'main' | 'child', url: string, parent: unknown) => ({
    isDetached: () => false,
    url: () => url,
    parentFrame: () => parent,
    // The <iframe> element in the parent: asked from there, its document is
    // reached without entering the frame's own context (no gate, no wait).
    frameElement: () => (name === 'child' && options.childElement === 'never'
      ? new Promise(() => {})
      : Promise.resolve({
        evaluate: async (_fn: unknown, args?: { method: string }) => {
          calls.push(`${name}^:${args?.method ?? 'probe'}`);
          if (args?.method === 'end') host[name] = false;
          return host[name];
        },
        dispose: async () => {
          if (name === 'child') elementDisposed = true;
        },
      })),
    evaluate: vi.fn(async (_fn: unknown, args?: { method: string }) => {
      calls.push(`${name}:${args?.method ?? 'probe'}`);
      const held = host[name];
      const gate = name === 'child' ? options.childGate?.() : undefined;
      if (gate !== undefined) await gate;
      if (args?.method === 'end') host[name] = false;
      return gate !== undefined ? held : host[name];
    }),
  });
  const main = frame('main', 'https://app.test/', null);
  const child = frame('child', options.childUrl ?? 'https://child.test/', main);
  const page = {
    frames: () => [main, child],
    mainFrame: () => main,
    on: (event: string, fn: (frame?: unknown) => void) => {
      if (event === 'close') listeners.push(fn);
      if (event === 'framedetached') detachedListeners.push(fn);
    },
    off: () => {},
    isClosed: () => closed,
    context: () => ({
      browser: () => connection?.browser ?? null,
      newCDPSession: async (target: unknown) => {
        if (target === child && options.childOutOfProcess !== true) {
          throw new Error('This frame does not have a separate CDP session');
        }
        if (target === child) return { send: async () => ({}), detach: async () => {} };
        lookups++;
        await options.lookup?.();
        return {
          send: async (method: string) =>
            method === 'Target.getTargets' && options.alive !== undefined
              ? { targetInfos: options.alive().map((id) => ({ targetId: id })) }
              : { targetInfo: { targetId } },
          detach: async () => {},
        };
      },
    }),
  } as unknown as Page;
  return {
    page,
    calls,
    host,
    lookups: () => lookups,
    close: () => {
      closed = true;
      for (const fn of [...listeners]) fn();
    },
    detachChild: () => {
      for (const fn of [...detachedListeners]) fn(child);
    },
    childElementDisposed: () => elementDisposed,
  };
}

describe('a tab shared by Pages on one CDP endpoint (review 17)', () => {
  let clock = 0;
  /** A draw through `page` that lands in the frame at `href`, or answers
   *  only when `answer` does. */
  function draw(page: Page, href: string, answer?: Promise<unknown>): void {
    const locator = {
      page: () => page,
      evaluateAll: () => answer ?? Promise.resolve({ drawn: 1, href }),
      first: () => locator,
    };
    H.createHighlighter({ ...H.HIGHLIGHT_DEFAULTS, durationMs: 2_000 }, { now: () => clock }).mark(locator as never, 'act');
  }
  /** A disconnect from the tab, which stays open: what closeBrowser does. */
  function detach(p: { page: Page; close: () => void }): void {
    H.pagesDetaching([p.page]);
    p.close();
  }
  const hides = (calls: string[]): string[] => calls.filter((c) => c.endsWith(':hide'));
  const capture = (p: { page: Page }, at = 60_000): Promise<string> => H.hiddenFor(p.page, async () => 'shot', { now: () => at });

  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('endpoint scoping: a launched-browser page and a page on another endpoint never look a target id up', async () => {
    const a = tabPage(cdpConnection('localhost:9222'));
    a.host.main = true; // a host that stays: the record stays
    draw(a.page, 'https://app.test/');
    await vi.advanceTimersByTimeAsync(0);
    const launched = tabPage(null);
    const elsewhere = tabPage(cdpConnection('localhost:9333'));
    expect(await capture(launched)).toBe('shot');
    expect(await capture(elsewhere)).toBe('shot');
    expect(launched.lookups()).toBe(0);
    expect(elsewhere.lookups()).toBe(0);
    expect(launched.calls).toEqual([]);
    expect(elsewhere.calls).toEqual([]);
  });

  it('all Pages hold: one that drew there before and confirmed still hides a ring another Page left', async () => {
    const connection = cdpConnection('localhost:9222');
    const a = tabPage(connection);
    const b = tabPage(connection);
    draw(b.page, 'https://app.test/');
    await vi.advanceTimersByTimeAsync(0);
    clock = 3_500;
    await vi.advanceTimersByTimeAsync(3_500); // B's own confirmation: every frame clear
    draw(a.page, 'https://child.test/');
    await vi.advanceTimersByTimeAsync(0);
    b.host.child = true; // A's ring outlives its clock (a late start, §16.10)
    detach(a);
    b.calls.length = 0;
    await capture(b);
    expect(hides(b.calls)).toContain('child:hide');
  });

  it('end 1: a round through any Page that finds every frame clear ends the record', async () => {
    const connection = cdpConnection('localhost:9222');
    const a = tabPage(connection);
    const c = tabPage(connection); // never draws
    a.host.child = true;
    draw(a.page, 'https://child.test/');
    await vi.advanceTimersByTimeAsync(0);
    detach(a);
    c.host.child = true;
    await capture(c);
    expect(hides(c.calls)).toContain('child:hide');
    c.host.child = false; // the ring retires
    await capture(c); // every frame answers "no host"
    c.calls.length = 0;
    await capture(c);
    expect(c.calls).toEqual([]);
  });

  it('end 2: a drawing Page closing without its owner saying "detaching" closes the tab, and ends the record', async () => {
    const connection = cdpConnection('localhost:9222');
    const a = tabPage(connection);
    const b = tabPage(connection);
    a.host.child = true;
    draw(a.page, 'https://child.test/');
    await vi.advanceTimersByTimeAsync(0);
    a.close(); // page.close(): the tab is gone
    await vi.advanceTimersByTimeAsync(0);
    expect(await capture(b)).toBe('shot');
    expect(b.calls).toEqual([]);
  });

  it('end 3: the last connection to the endpoint going ends its records', async () => {
    const first = cdpConnection('localhost:9222');
    const a = tabPage(first);
    a.host.child = true;
    draw(a.page, 'https://child.test/');
    await vi.advanceTimersByTimeAsync(0);
    detach(a);
    first.disconnect();
    // A later connection to the same browser finds nothing recorded.
    const later = tabPage(cdpConnection('localhost:9222'));
    expect(await capture(later)).toBe('shot');
    expect(later.calls).toEqual([]);
    expect(later.lookups()).toBe(0);
  });

  it('R: a ring drawn while a departed drawer\'s record lives is confirmed with it, and then nothing is held', async () => {
    const connection = cdpConnection('localhost:9222');
    const a = tabPage(connection);
    const b = tabPage(connection);
    const c = tabPage(connection); // never draws
    a.host.child = true;
    draw(a.page, 'https://child.test/');
    await vi.advanceTimersByTimeAsync(0);
    detach(a); // mid-ring
    clock = 1_000;
    draw(b.page, 'https://app.test/');
    await vi.advanceTimersByTimeAsync(0);
    b.host.child = false; // every ring retires
    clock = 4_500;
    await vi.advanceTimersByTimeAsync(4_500); // B's confirmation asks every frame
    expect(b.calls).toContain('child:probe');
    expect(await capture(c)).toBe('shot');
    expect(c.calls).toEqual([]);
  });

  it('V: two drawers, one leaves with nothing unconfirmed; the other\'s confirmation ends the record', async () => {
    const connection = cdpConnection('localhost:9222');
    const a = tabPage(connection);
    const b = tabPage(connection);
    const c = tabPage(connection);
    draw(b.page, 'https://app.test/');
    draw(a.page, 'https://child.test/');
    await vi.advanceTimersByTimeAsync(0);
    clock = 3_500;
    await vi.advanceTimersByTimeAsync(3_500); // both confirmations: every host gone
    detach(a);
    expect(await capture(c)).toBe('shot');
    expect(c.calls).toEqual([]);
  });

  it('a host that never retires on a detached errand\'s tab stays hidden from every Page, past every confirmation retry', async () => {
    const connection = cdpConnection('localhost:9222');
    const a = tabPage(connection);
    const b = tabPage(connection);
    const c = tabPage(connection);
    draw(b.page, 'https://app.test/');
    draw(a.page, 'https://child.test/');
    await vi.advanceTimersByTimeAsync(0);
    b.host.child = true; // paused: never retires
    detach(a);
    clock = 3_500;
    await vi.advanceTimersByTimeAsync(400_000); // B's 11 probes, and long after
    for (const p of [b, c]) {
      p.calls.length = 0;
      await capture(p, 500_000);
      expect(hides(p.calls)).toContain('child:hide');
    }
  });

  it('the race: a capture started inside the detaching Page\'s close event still hides', async () => {
    const connection = cdpConnection('localhost:9222');
    const a = tabPage(connection);
    const b = tabPage(connection);
    b.host.child = true;
    draw(a.page, 'https://child.test/');
    await vi.advanceTimersByTimeAsync(0);
    let raced: Promise<string> | undefined;
    a.page.on('close', () => {
      raced = capture(b);
    });
    detach(a);
    await raced;
    expect(hides(b.calls)).toContain('child:hide');
  });
});

describe('what a Page on a shared tab cannot see or tell (review 19)', () => {
  let clock = 0;
  function draw(page: Page, href: string, answer?: Promise<unknown>): void {
    const locator = {
      page: () => page,
      evaluateAll: () => answer ?? Promise.resolve({ drawn: 1, href }),
      first: () => locator,
    };
    H.createHighlighter({ ...H.HIGHLIGHT_DEFAULTS, durationMs: 2_000 }, { now: () => clock }).mark(locator as never, 'act');
  }
  const hides = (calls: string[]): string[] => calls.filter((c) => c.endsWith(':hide'));
  const capture = (p: { page: Page }, at = 60_000): Promise<string> => H.hiddenFor(p.page, async () => 'shot', { now: () => at });
  /** A gate the test opens. */
  function gate(): { promise: Promise<void>; open: () => void } {
    let open: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('item 1: a frame with no address, as a cross-site frame loaded before the attach reads, is hidden, and one that cannot answer is not clear', async () => {
    const connection = cdpConnection('localhost:9222');
    const host = { main: false, child: true };
    const a = tabPage(connection, 'tab-1', { host });
    let stalled: Promise<void> | undefined;
    const c = tabPage(connection, 'tab-1', { host, childUrl: '', childOutOfProcess: true, childGate: () => stalled });
    draw(a.page, 'https://child.test/');
    await vi.advanceTimersByTimeAsync(0);
    await capture(c);
    expect(hides(c.calls)).toContain('child:hide');
    // The frame stops answering, with nothing of ours left in it: that round
    // cannot confirm the tab.
    host.child = false;
    stalled = new Promise<void>(() => {});
    const round = capture(c);
    await vi.advanceTimersByTimeAsync(1_000);
    await round;
    stalled = undefined;
    host.child = true; // as if its answer had been stale: the record must still be there
    c.calls.length = 0;
    await capture(c);
    expect(hides(c.calls)).toContain('child:hide');
  });

  it('item 2: a Page whose own lookup runs out of time holds every frame, and confirms nothing', async () => {
    const connection = cdpConnection('localhost:9222');
    const host = { main: false, child: true };
    const a = tabPage(connection, 'tab-1', { host });
    const never = () => new Promise<void>(() => {});
    const b = tabPage(connection, 'tab-1', { host, lookup: never });
    const d = tabPage(connection, 'tab-1', { host });
    draw(a.page, 'https://child.test/');
    await vi.advanceTimersByTimeAsync(0);
    const first = capture(b);
    await vi.advanceTimersByTimeAsync(1_100);
    await first;
    expect(hides(b.calls)).toEqual(['main:hide', 'child:hide']);
    // Every frame of its own tab clear, as far as B can see: still, B could
    // not say which tab it is on, so nothing is confirmed.
    host.child = false;
    await capture(b);
    host.child = true;
    await capture(d);
    expect(hides(d.calls)).toContain('child:hide');
  });

  it('item 3: a capture\'s round that a draw starts and lands during confirms nothing', async () => {
    const connection = cdpConnection('localhost:9222');
    const host = { main: false, child: false };
    let held: Promise<void> | undefined;
    const a = tabPage(connection, 'tab-1', { host });
    const c = tabPage(connection, 'tab-1', { host, childGate: () => held });
    draw(a.page, 'https://child.test/');
    await vi.advanceTimersByTimeAsync(0);
    const slow = gate();
    held = slow.promise;
    const round = capture(c); // the child's answer is taken now: no host
    await vi.advanceTimersByTimeAsync(0);
    draw(a.page, 'https://app.test/'); // a new ring starts and lands meanwhile
    host.main = true;
    await vi.advanceTimersByTimeAsync(0);
    slow.open();
    held = undefined;
    await round;
    c.calls.length = 0;
    await capture(c);
    expect(hides(c.calls)).toContain('main:hide');
  });

  it('item 3: a confirmation round that a draw starts and lands during confirms nothing', async () => {
    const connection = cdpConnection('localhost:9222');
    const host = { main: false, child: false };
    let held: Promise<void> | undefined;
    const a = tabPage(connection, 'tab-1', { host, childGate: () => held });
    const c = tabPage(connection, 'tab-1', { host });
    draw(a.page, 'https://child.test/'); // until 3 000
    await vi.advanceTimersByTimeAsync(0);
    const slow = gate();
    held = slow.promise;
    clock = 3_000;
    await vi.advanceTimersByTimeAsync(3_000); // A's own round starts; the child's answer (no host) waits
    expect(a.calls).toContain('child:probe');
    draw(a.page, 'https://app.test/'); // a new ring starts and lands meanwhile
    host.main = true;
    await vi.advanceTimersByTimeAsync(0);
    slow.open(); // within the probe's budget: the round ends with every frame "clear"
    held = undefined;
    await vi.advanceTimersByTimeAsync(0);
    await capture(c);
    expect(hides(c.calls)).toContain('main:hide');
  });

  it('item 1: the drawing Page\'s confirmation counts a frame that cannot answer as not clear', async () => {
    const connection = cdpConnection('localhost:9222');
    const host = { main: false, child: false };
    let stalled: Promise<void> | undefined;
    const a = tabPage(connection, 'tab-1', { host, childGate: () => stalled });
    const c = tabPage(connection, 'tab-1', { host });
    draw(a.page, 'https://child.test/'); // until 3 000
    await vi.advanceTimersByTimeAsync(0);
    stalled = new Promise<void>(() => {}); // the child stops answering
    clock = 3_000;
    await vi.advanceTimersByTimeAsync(3_600); // A's round: main clear, child no answer
    expect(a.calls).toContain('child:probe');
    stalled = undefined;
    host.child = true; // what the child held all along
    await capture(c);
    expect(hides(c.calls)).toContain('child:hide');
  });

  it('item 4: a capture\'s round with a draw on the tab in flight does not end the record', async () => {
    const connection = cdpConnection('localhost:9222');
    const host = { main: false, child: false };
    const a = tabPage(connection, 'tab-1', { host });
    const c = tabPage(connection, 'tab-1', { host });
    draw(a.page, 'https://child.test/');
    await vi.advanceTimersByTimeAsync(0);
    draw(a.page, 'https://app.test/', new Promise(() => {})); // in flight, for good
    await vi.advanceTimersByTimeAsync(0);
    const first = capture(c); // every frame answers no host, but a draw is on its way
    await vi.advanceTimersByTimeAsync(20_000);
    await first.catch(() => 'no picture');
    c.calls.length = 0;
    // The draw may still land at any moment: the next capture must hide.
    const second = capture(c);
    await vi.advanceTimersByTimeAsync(20_000);
    await second.catch(() => 'no picture');
    expect(hides(c.calls)).toContain('main:hide');
  });

  it('item 4: the drawing Page\'s confirmation with a draw of its own in flight does not end the record', async () => {
    const connection = cdpConnection('localhost:9222');
    const host = { main: false, child: false };
    const a = tabPage(connection, 'tab-1', { host });
    const c = tabPage(connection, 'tab-1', { host });
    draw(a.page, 'https://child.test/'); // until 3 000
    await vi.advanceTimersByTimeAsync(0);
    draw(a.page, 'https://app.test/', new Promise(() => {})); // in flight when A's round comes
    await vi.advanceTimersByTimeAsync(0);
    clock = 3_500;
    await vi.advanceTimersByTimeAsync(3_500); // A's own round: every frame clear
    expect(a.calls).toContain('child:probe');
    const shot = capture(c);
    await vi.advanceTimersByTimeAsync(20_000);
    await shot.catch(() => 'no picture');
    expect(hides(c.calls)).toContain('main:hide');
  });

  it('item 4: a capture waits for a lookup in flight on its endpoint before it decides', async () => {
    const connection = cdpConnection('localhost:9222');
    const host = { main: false, child: false };
    const lookup = gate();
    const a = tabPage(connection, 'tab-1', { host, lookup: () => lookup.promise });
    const c = tabPage(connection, 'tab-1', { host });
    // A draw whose record waits on A's lookup, and which has not landed.
    draw(a.page, 'https://child.test/', new Promise(() => {}));
    const shot = capture(c);
    await vi.advanceTimersByTimeAsync(0);
    lookup.open();
    await vi.advanceTimersByTimeAsync(20_000);
    await shot.catch(() => 'no picture');
    expect(hides(c.calls)).toContain('main:hide');
  });

  it('item 5: a ring stamped on the page while a picture is taken with nothing hidden is retaken through the hide', async () => {
    const p = tabPage(null);
    let shots = 0;
    const picture = await H.hiddenFor(p.page, async () => {
      shots++;
      if (shots === 1) draw(p.page, 'https://app.test/');
      return `shot ${shots}`;
    }, { now: () => 0 });
    expect(picture).toBe('shot 2');
    expect(hides(p.calls)).toContain('main:hide');
  });

  it('item 6: a lookup drops the record of a tab that no longer exists', async () => {
    const connection = cdpConnection('localhost:9222');
    const tabs = ['tab-1', 'tab-2', 'tab-3'];
    const alive = () => tabs;
    const a = tabPage(connection, 'tab-1', { alive });
    a.host.child = true;
    draw(a.page, 'https://child.test/');
    await vi.advanceTimersByTimeAsync(0);
    H.pagesDetaching([a.page]);
    a.close();
    tabs.splice(tabs.indexOf('tab-1'), 1); // the user closes tab-1
    const first = tabPage(connection, 'tab-2', { alive });
    await capture(first);
    expect(first.lookups()).toBe(1);
    const next = tabPage(connection, 'tab-3', { alive });
    await capture(next);
    expect(next.lookups()).toBe(0);
  });
});

describe('frames with no document, draws that land mid-wait, and retakes (review 21)', () => {
  let clock = 0;
  function draw(page: Page, href: string, answer?: Promise<unknown>): void {
    const locator = {
      page: () => page,
      evaluateAll: () => answer ?? Promise.resolve({ drawn: 1, href }),
      first: () => locator,
    };
    H.createHighlighter({ ...H.HIGHLIGHT_DEFAULTS, durationMs: 2_000 }, { now: () => clock }).mark(locator as never, 'act');
  }
  const hides = (calls: string[]): string[] => calls.filter((c) => c.endsWith(':hide'));
  const never = new Promise<void>(() => {});

  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('a frame with no document on an attached Page (a lazy iframe, \':\') is asked only through its parent, never in its own context, and does not stop the tab being confirmed', async () => {
    const connection = cdpConnection('localhost:9222');
    const host = { main: false, child: false };
    const a = tabPage(connection, 'tab-1', { host, childUrl: ':', childGate: () => never });
    const c = tabPage(connection, 'tab-1', { host, childUrl: ':', childGate: () => never });
    draw(a.page, 'https://app.test/');
    await vi.advanceTimersByTimeAsync(0);
    let done = false;
    const shot = H.hiddenFor(c.page, async () => 'shot', { now: () => 60_000 }).then((picture) => {
      done = true;
      return picture;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(true);
    await shot;
    expect(c.calls.filter((call) => call.startsWith('child:'))).toEqual([]);
    // That round found every frame with a document clear: nothing is held.
    c.calls.length = 0;
    await H.hiddenFor(c.page, async () => 'shot', { now: () => 60_000 });
    expect(c.calls).toEqual([]);
  });

  it('a frame with no address on a launched page is asked only through its parent', async () => {
    const p = tabPage(null, 'tab-1', { childUrl: '', childGate: () => never });
    draw(p.page, 'https://app.test/');
    await vi.advanceTimersByTimeAsync(0);
    let done = false;
    void H.hiddenFor(p.page, async () => 'shot', { now: () => 0 }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(true);
    expect(p.calls.filter((call) => call.startsWith('child:'))).toEqual([]);
  });

  it('a draw that lands while a capture waits on a busy frame ends the no-escape wait', async () => {
    const p = tabPage(null, 'tab-1', { childGate: () => never }); // the child never answers
    let land: (value: unknown) => void = () => {};
    draw(p.page, 'https://app.test/', new Promise((resolve) => {
      land = resolve;
    }));
    await vi.advanceTimersByTimeAsync(0);
    let picture: string | undefined;
    void H.hiddenFor(p.page, async () => 'shot', { now: () => 60_000 }).then((shot) => {
      picture = shot;
    }, () => {
      picture = 'no picture';
    });
    await vi.advanceTimersByTimeAsync(100);
    land({ drawn: 1, href: 'https://app.test/' }); // lands: its lifetime (on this clock) is long over
    await vi.advanceTimersByTimeAsync(1_000);
    expect(picture).toBe('shot');
  });

  it('a restore is not waited on where its hide never landed', async () => {
    const p = tabPage(null, 'tab-1', { childGate: () => never });
    draw(p.page, 'https://child.test/'); // the child drew, until 3 000
    await vi.advanceTimersByTimeAsync(0);
    let done = false;
    void H.hiddenFor(p.page, async () => 'shot', { now: () => 60_000 }).then(() => {
      done = true;
    });
    // The child's hide is given 500 ms, then the picture goes ahead (its
    // lifetime has passed); its restore is sent, not waited on.
    await vi.advanceTimersByTimeAsync(600);
    expect(done).toBe(true);
  });

  it('a highlight-off capture is not retaken when another tab of the same browser draws during it', async () => {
    const connection = cdpConnection('localhost:9222');
    const other = tabPage(connection, 'tab-1');
    const off = tabPage(connection, 'tab-2');
    let shots = 0;
    await H.hiddenFor(off.page, async () => {
      shots++;
      draw(other.page, 'https://app.test/');
      await vi.advanceTimersByTimeAsync(0);
      return 'shot';
    });
    expect(shots).toBe(1);
    expect(off.calls).toEqual([]);
  });

  it('a capture is retaken when another Page of its own tab draws during it', async () => {
    const connection = cdpConnection('localhost:9222');
    const other = tabPage(connection, 'tab-1');
    const same = tabPage(connection, 'tab-1');
    let shots = 0;
    await H.hiddenFor(same.page, async () => {
      shots++;
      if (shots === 1) {
        draw(other.page, 'https://app.test/');
        await vi.advanceTimersByTimeAsync(0);
      }
      return 'shot';
    }, { now: () => 0 });
    expect(shots).toBe(2);
    expect(hides(same.calls)).toContain('main:hide');
  });

  it('a capture through the hide is retaken, once, when a ring is stamped on its page during it', async () => {
    const p = tabPage(null);
    draw(p.page, 'https://app.test/'); // a ring of ours is up: the hide path
    await vi.advanceTimersByTimeAsync(0);
    let shots = 0;
    await H.hiddenFor(p.page, async () => {
      shots++;
      // Another caller marks, every time: still only one retake.
      draw(p.page, 'https://child.test/');
      await vi.advanceTimersByTimeAsync(0);
      return 'shot';
    }, { now: () => 0 });
    expect(shots).toBe(2);
    expect(hides(p.calls).length).toBeGreaterThanOrEqual(4); // two rounds over two frames
  });
});

describe('a frame held only by the fallback, with no document (review 21)', () => {
  it('is never probed in its own context, its parent answers for it, and nothing is held after the ring', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const never = new Promise<void>(() => {});
    const p = tabPage(null, 'tab-1', { childUrl: '', childGate: () => never });
    let clock = 0;
    // A draw whose address matches no frame: every frame is held, the
    // document-less child included.
    const locator = {
      page: () => p.page,
      evaluateAll: () => Promise.resolve({ drawn: 1, href: 'https://elsewhere.test/' }),
      first: () => locator,
    };
    H.createHighlighter({ ...H.HIGHLIGHT_DEFAULTS, durationMs: 2_000 }, { now: () => clock }).mark(locator as never, 'act');
    await vi.advanceTimersByTimeAsync(0);
    clock = 3_500;
    await vi.advanceTimersByTimeAsync(3_500); // the page's own confirmation
    expect(p.calls).toContain('main:probe');
    expect(p.calls.filter((call) => call.startsWith('child:'))).toEqual([]);
    p.calls.length = 0;
    expect(await H.hiddenFor(p.page, async () => 'shot', { now: () => 10_000 })).toBe('shot');
    expect(p.calls).toEqual([]);
  });
});

describe('the lifetime edge and an unknown tab\'s draws (review 23, item 2)', () => {
  const never = new Promise<void>(() => {});

  it('a wait whose timer fires before the clock reaches the lifetime waits out the remainder, and the picture is taken', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = tabPage(null, 'tab-1', { childGate: () => never }); // the child never answers
    let clock = 0;
    const locator = {
      page: () => p.page,
      evaluateAll: () => Promise.resolve({ drawn: 1, href: 'https://child.test/' }),
      first: () => locator,
    };
    H.createHighlighter({ ...H.HIGHLIGHT_DEFAULTS, durationMs: 2_000 }, { now: () => clock }).mark(locator as never, 'act');
    await vi.advanceTimersByTimeAsync(0); // the child's ring lives until 3 000 on this clock
    let picture: string | undefined;
    void H.hiddenFor(p.page, async () => 'shot', { now: () => clock }).then((shot) => {
      picture = shot;
    }, () => {
      picture = 'no picture';
    });
    // The 3 000 ms timer fires with the clock 1 ms short of the lifetime.
    clock = 2_999;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(picture).toBeUndefined();
    clock = 3_000;
    await vi.advanceTimersByTimeAsync(10);
    expect(picture).toBe('shot');
  });

  it('a page that cannot tell its tab waits for the endpoint\'s draws in flight like any other', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const connection = cdpConnection('localhost:9222');
    const host = { main: false, child: false };
    const a = tabPage(connection, 'tab-1', { host });
    const b = tabPage(connection, 'tab-1', { host, childGate: () => never, lookup: () => never });
    let land: (value: unknown) => void = () => {};
    const locator = {
      page: () => a.page,
      evaluateAll: () => new Promise((resolve) => {
        land = resolve;
      }),
      first: () => locator,
    };
    H.createHighlighter({ ...H.HIGHLIGHT_DEFAULTS, durationMs: 2_000 }, { now: () => 0 }).mark(locator as never, 'act');
    await vi.advanceTimersByTimeAsync(0); // A's draw is on its way; its tab is recorded
    let picture: string | undefined;
    void H.hiddenFor(b.page, async () => 'shot', { now: () => 60_000 }).then((shot) => {
      picture = shot;
    }, () => {
      picture = 'no picture';
    });
    // Past the lookup's budget and the lifetime on B's clock: B still waits,
    // since A's draw has not started its ring.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(picture).toBeUndefined();
    land({ drawn: 1, href: 'https://app.test/' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(picture).toBe('shot');
  });
});

describe('a frame with no address whose element cannot be found (review 23)', () => {
  it('is not asked, and a held entry for it is dropped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const never = new Promise<void>(() => {});
    const p = tabPage(null, 'tab-1', { childUrl: '', childGate: () => never });
    const child = p.page.frames()[1] as unknown as { frameElement: () => Promise<unknown> };
    child.frameElement = () => Promise.reject(new Error('Frame has been detached.'));
    let clock = 0;
    const locator = {
      page: () => p.page,
      evaluateAll: () => Promise.resolve({ drawn: 1, href: 'https://elsewhere.test/' }),
      first: () => locator,
    };
    H.createHighlighter({ ...H.HIGHLIGHT_DEFAULTS, durationMs: 2_000 }, { now: () => clock }).mark(locator as never, 'act');
    await vi.advanceTimersByTimeAsync(0);
    clock = 3_500;
    await vi.advanceTimersByTimeAsync(3_500); // the page's own confirmation
    expect(p.calls.filter((call) => call.startsWith('child'))).toEqual([]);
    p.calls.length = 0;
    expect(await H.hiddenFor(p.page, async () => 'shot', { now: () => 10_000 })).toBe('shot');
    expect(p.calls).toEqual([]);
  });
});

describe('the <iframe> element behind a frame with no address (review 24)', () => {
  it('a lookup that outruns its budget keeps the frame asked and its entry held: it counts as not landed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The parent is busy: frame.frameElement() runs on its main thread.
    const p = tabPage(null, 'tab-1', { childUrl: '', childElement: 'never' });
    let clock = 0;
    const locator = {
      page: () => p.page,
      evaluateAll: () => Promise.resolve({ drawn: 1, href: 'https://elsewhere.test/' }), // holds every frame
      first: () => locator,
    };
    H.createHighlighter({ ...H.HIGHLIGHT_DEFAULTS, durationMs: 2_000 }, { now: () => clock }).mark(locator as never, 'act');
    await vi.advanceTimersByTimeAsync(0);
    let picture: string | undefined;
    void H.hiddenFor(p.page, async () => 'shot', { now: () => clock }).then((shot) => {
      picture = shot;
    }, () => {
      picture = 'no picture';
    });
    // Within the ring's lifetime the frame is waited on, past the lookup's 1 s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(picture).toBeUndefined();
    clock = 3_500; // the lifetime passes: the picture goes ahead
    await vi.advanceTimersByTimeAsync(2_000);
    expect(picture).toBe('shot');
    // Its entry was not dropped: the page still has a ring of ours to hide.
    p.calls.length = 0;
    void H.hiddenFor(p.page, async () => 'again', { now: () => clock });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(p.calls).toContain('main:hide');
  });

  it('is disposed when the frame detaches', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = tabPage(null, 'tab-1', { childUrl: '' });
    const locator = {
      page: () => p.page,
      evaluateAll: () => Promise.resolve({ drawn: 1, href: 'https://app.test/' }),
      first: () => locator,
    };
    H.createHighlighter({ ...H.HIGHLIGHT_DEFAULTS, durationMs: 2_000 }, { now: () => 0 }).mark(locator as never, 'act');
    await vi.advanceTimersByTimeAsync(0);
    await H.hiddenFor(p.page, async () => 'shot', { now: () => 0 }); // looks the element up
    expect(p.calls).toContain('child^:hide');
    expect(p.childElementDisposed()).toBe(false);
    p.detachChild();
    await vi.advanceTimersByTimeAsync(0);
    expect(p.childElementDisposed()).toBe(true);
  });
});
