/**
 * Tests for the three-form scroll action (stories/scroll-steps.md):
 *   - `selector`  → eased glide + scrollIntoViewIfNeeded, routed through `root`
 *   - `to`        → absolute, pointer-independent, eased
 *   - `direction` → the original mouse-wheel path, byte-identical to before
 *
 * Two layers, deliberately:
 *   1. Routing, with the mocked Page/FrameLocator pattern from iframe.test.ts.
 *   2. The browser-side animator itself, run for real against a fake scroller
 *      and frame loop: the only way to check that "scroll to the bottom" lands
 *      on scrollHeight − clientHeight, that an already-at-bottom page is a
 *      clean no-op rather than a jump — and the motion itself, its duration
 *      and its curve, which live only inside the serialized callback.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { executeAction } from '../src/browser/actions.js';
import {
  buildStepMessage,
  buildContinuationMessage,
  formatScrollPosition,
} from '../src/ai/prompts.js';
import { DEFAULT_BROWSER_DIMENSIONS } from '../src/config/browser-dimensions.js';
import type { Page, FrameLocator, Locator } from 'playwright';

// ─── Mocks ───────────────────────────────────────────────────────────────────

function makeMockLocator(): Locator {
  const locator: Locator = {
    locator: vi.fn().mockImplementation(() => locator),
    first: vi.fn().mockReturnThis(),
    click: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(1),
    boundingBox: vi.fn().mockResolvedValue({ x: 0, y: 1200, width: 400, height: 200 }),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
  } as unknown as Locator;
  return locator;
}

function makeMockFrameLocator(): { frameLocator: FrameLocator; innerLocator: Locator } {
  const innerLocator = makeMockLocator();
  const frameLocator = {
    locator: vi.fn().mockReturnValue(innerLocator),
    frameLocator: vi.fn(),
  } as unknown as FrameLocator;
  return { frameLocator, innerLocator };
}

function makeMockPage(frameLocatorMap: Record<string, FrameLocator> = {}): {
  page: Page;
  pageLocator: Locator;
} {
  const pageLocator = makeMockLocator();
  const page = {
    locator: vi.fn().mockReturnValue(pageLocator),
    frameLocator: vi.fn().mockImplementation((sel: string) => {
      const fl = frameLocatorMap[sel];
      if (!fl) throw new Error(`No mock frame for selector: ${sel}`);
      return fl;
    }),
    evaluate: vi.fn().mockResolvedValue(undefined),
    mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
    viewportSize: vi.fn().mockReturnValue({ ...DEFAULT_BROWSER_DIMENSIONS }),
    url: vi.fn().mockReturnValue('http://localhost/'),
  } as unknown as Page;
  return { page, pageLocator };
}

const wheelOf = (page: Page) => page.mouse.wheel as ReturnType<typeof vi.fn>;
const evaluateOf = (page: Page) => page.evaluate as ReturnType<typeof vi.fn>;

// ─── Routing: which branch runs ──────────────────────────────────────────────

describe('executeScroll — absolute "to" branch', () => {
  it('animates in-page and never touches the mouse wheel', async () => {
    const { page } = makeMockPage();

    const result = await executeAction(page, {
      action: 'scroll',
      to: 'bottom',
      description: 'Scroll to the bottom of the page',
    });

    expect(result.success).toBe(true);
    expect(evaluateOf(page)).toHaveBeenCalledTimes(1);
    expect(wheelOf(page)).not.toHaveBeenCalled();
  });

  it('hands the target to the browser-side animator', async () => {
    const { page } = makeMockPage();

    await executeAction(page, { action: 'scroll', to: 'top', description: 'Back to the top' });

    const [callback, args] = evaluateOf(page).mock.calls[0]!;
    expect(typeof callback).toBe('function');
    expect(args).toMatchObject({ target: 'top' });
  });
});

describe('executeScroll — "selector" branch', () => {
  it('brings the element into view through the page root', async () => {
    const { page, pageLocator } = makeMockPage();

    const result = await executeAction(page, {
      action: 'scroll',
      selector: '#reviews',
      description: 'Bring the reviews section into view',
    });

    expect(result.success).toBe(true);
    expect(page.locator).toHaveBeenCalledWith('#reviews');
    expect(pageLocator.scrollIntoViewIfNeeded).toHaveBeenCalled();
    expect(wheelOf(page)).not.toHaveBeenCalled();
  });

  it('glides first, then backstops with scrollIntoViewIfNeeded', async () => {
    const { page, pageLocator } = makeMockPage();

    await executeAction(page, { action: 'scroll', selector: '#reviews', description: 'Scroll to reviews' });

    // The measured offset becomes the animator's delta.
    expect(evaluateOf(page).mock.calls[0]![1]).toMatchObject({ target: { deltaY: 1200 } });
    expect(pageLocator.boundingBox).toHaveBeenCalled();
    expect(pageLocator.scrollIntoViewIfNeeded).toHaveBeenCalled();
  });

  it('routes through a FrameLocator root when "frame" is set', async () => {
    const { frameLocator, innerLocator } = makeMockFrameLocator();
    const { page } = makeMockPage({ '#feed-frame': frameLocator });

    const result = await executeAction(page, {
      action: 'scroll',
      selector: '#reviews',
      frame: '#feed-frame',
      description: 'Scroll to reviews inside the feed iframe',
    });

    expect(result.success).toBe(true);
    expect(frameLocator.locator).toHaveBeenCalledWith('#reviews');
    expect(innerLocator.scrollIntoViewIfNeeded).toHaveBeenCalled();
  });

  it('skips the glide but still scrolls when the element cannot be measured', async () => {
    const { page, pageLocator } = makeMockPage();
    (pageLocator.boundingBox as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await executeAction(page, {
      action: 'scroll',
      selector: '#reviews',
      description: 'Scroll to reviews',
    });

    expect(result.success).toBe(true);
    expect(evaluateOf(page)).not.toHaveBeenCalled();
    expect(pageLocator.scrollIntoViewIfNeeded).toHaveBeenCalled();
  });
});

describe('executeScroll — wheel path (unchanged)', () => {
  const cases: Array<{ action: Parameters<typeof executeAction>[1]; delta: [number, number] }> = [
    { action: { action: 'scroll', description: 'Scroll down a bit' }, delta: [0, 300] },
    { action: { action: 'scroll', direction: 'down', amount: 500, description: 'd' }, delta: [0, 500] },
    { action: { action: 'scroll', direction: 'up', amount: 500, description: 'd' }, delta: [0, -500] },
    { action: { action: 'scroll', direction: 'left', amount: 250, description: 'd' }, delta: [-250, 0] },
    { action: { action: 'scroll', direction: 'right', amount: 250, description: 'd' }, delta: [250, 0] },
    { action: { action: 'scroll', direction: 'up', description: 'd' }, delta: [0, -300] },
  ];

  for (const { action, delta } of cases) {
    it(`${action.direction ?? '(default down)'} ${action.amount ?? '(default 300)'} → wheel(${delta[0]}, ${delta[1]})`, async () => {
      const { page } = makeMockPage();

      const result = await executeAction(page, action);

      expect(result.success).toBe(true);
      expect(wheelOf(page)).toHaveBeenCalledWith(delta[0], delta[1]);
      expect(evaluateOf(page)).not.toHaveBeenCalled();
    });
  }
});

describe('executeScroll — precedence when fields are combined', () => {
  it('selector beats "to" and "direction"', async () => {
    const { page, pageLocator } = makeMockPage();

    await executeAction(page, {
      action: 'scroll',
      selector: '#reviews',
      to: 'bottom',
      direction: 'down',
      amount: 900,
      description: 'Everything at once',
    });

    expect(pageLocator.scrollIntoViewIfNeeded).toHaveBeenCalled();
    expect(wheelOf(page)).not.toHaveBeenCalled();
    // The one evaluate is the glide toward the element, not the "to" branch.
    expect(evaluateOf(page).mock.calls[0]![1]).toMatchObject({ target: { deltaY: 1200 } });
  });

  it('"to" beats "direction"', async () => {
    const { page } = makeMockPage();

    await executeAction(page, {
      action: 'scroll',
      to: 'bottom',
      direction: 'down',
      amount: 900,
      description: 'Redundant, not contradictory',
    });

    expect(evaluateOf(page).mock.calls[0]![1]).toMatchObject({ target: 'bottom' });
    expect(wheelOf(page)).not.toHaveBeenCalled();
  });
});

// ─── The browser-side animator, run for real ─────────────────────────────────

/** A stand-in for `document.scrollingElement` that records every write. */
function makeFakeScroller(init: { scrollTop: number; clientHeight: number; scrollHeight: number }) {
  const writes: number[] = [];
  let value = init.scrollTop;
  const el = {
    clientHeight: init.clientHeight,
    scrollHeight: init.scrollHeight,
    get scrollTop() { return value; },
    set scrollTop(v: number) { value = v; writes.push(v); },
  };
  return { el, writes, current: () => value };
}

/** The fake frame loop's frame interval. */
const FRAME_MS = 50;

/**
 * Install a fake document + frame loop, and a page whose `evaluate` actually
 * invokes the serialized callback instead of recording it.
 *
 * `performance` is left alone on purpose — stubbing the clock vitest itself
 * uses is not worth it. Frame k is stamped `FRAME_MS × k` after the clock as
 * the first frame was asked for, which is the animator's own start reading
 * give or take a statement — so a glide of D ms takes exactly D / 50 frames.
 * Frames are delivered as microtasks, so all of them arrive before the
 * animator's deadline timer could ever fire.
 */
function installFakeBrowser(
  scroller: ReturnType<typeof makeFakeScroller>,
  opts: { frames: boolean } = { frames: true },
): Page {
  vi.stubGlobal('document', { scrollingElement: scroller.el, documentElement: scroller.el });
  let base: number | null = null;
  let frame = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    if (!opts.frames) return 1; // a hidden page: rAF is throttled to zero
    base ??= performance.now();
    const at = base + FRAME_MS * ++frame;
    queueMicrotask(() => cb(at));
    return 1;
  });

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evaluate: vi.fn().mockImplementation((fn: any, args: unknown) => fn(args)),
    mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
    locator: vi.fn(),
    url: vi.fn().mockReturnValue('http://localhost/'),
  } as unknown as Page;
}

describe('browser-side scroll animator', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lands on scrollHeight − clientHeight, not scrollHeight', async () => {
    const scroller = makeFakeScroller({ scrollTop: 0, clientHeight: 800, scrollHeight: 5400 });
    const page = installFakeBrowser(scroller);

    await executeAction(page, { action: 'scroll', to: 'bottom', description: 'To the bottom' });

    expect(scroller.current()).toBe(4600);
    // Overshooting and letting the browser clamp would compress the visible
    // deceleration against the clamp — nothing may exceed the maximum.
    expect(Math.max(...scroller.writes)).toBeLessThanOrEqual(4600);
    expect(scroller.writes.length).toBeGreaterThan(1);
  });

  it('glides rather than teleporting, so lazy-loaders see the journey', async () => {
    const scroller = makeFakeScroller({ scrollTop: 0, clientHeight: 800, scrollHeight: 5400 });
    const page = installFakeBrowser(scroller);

    await executeAction(page, { action: 'scroll', to: 'bottom', description: 'To the bottom' });

    const intermediate = scroller.writes.slice(0, -1);
    expect(intermediate.length).toBeGreaterThan(0);
    expect(intermediate.every((v) => v > 0 && v < 4600)).toBe(true);
    // Monotonic, one direction only — no bounce past the target and back.
    for (let i = 1; i < scroller.writes.length; i++) {
      expect(scroller.writes[i]!).toBeGreaterThanOrEqual(scroller.writes[i - 1]!);
    }
  });

  /** Run one absolute scroll on a fresh fake scroller; answer every write. */
  async function glide(
    init: { scrollTop: number; clientHeight: number; scrollHeight: number },
    to: 'top' | 'bottom',
  ): Promise<number[]> {
    const scroller = makeFakeScroller(init);
    const page = installFakeBrowser(scroller);
    await executeAction(page, { action: 'scroll', to, description: `To the ${to}` });
    return scroller.writes;
  }

  // The duration is computed in the page, so it is read off the frames: the
  // animator writes once per frame, and a frame is 50 ms.
  it('takes 250 ms plus a quarter-millisecond per pixel, up or down', async () => {
    // 400 px: 350 ms. 2000 px: 750 ms. 400 px back up: 350 ms.
    expect(await glide({ scrollTop: 0, clientHeight: 800, scrollHeight: 1200 }, 'bottom')).toHaveLength(7);
    expect(await glide({ scrollTop: 0, clientHeight: 800, scrollHeight: 2800 }, 'bottom')).toHaveLength(15);
    expect(await glide({ scrollTop: 400, clientHeight: 800, scrollHeight: 2800 }, 'top')).toHaveLength(7);
  });

  it('stops gliding at 1200 ms however far it goes', async () => {
    for (const distance of [3_800, 4_600, 40_000]) { // 3800 px is exactly at the cap
      const writes = await glide({ scrollTop: 0, clientHeight: 800, scrollHeight: 800 + distance }, 'bottom');
      expect(writes, `${distance} px`).toHaveLength(1200 / FRAME_MS);
      expect(writes.at(-1), `${distance} px`).toBe(distance);
    }
  });

  it('decelerates: every frame moves it less than the frame before, the first one most', async () => {
    const writes = await glide({ scrollTop: 0, clientHeight: 800, scrollHeight: 5400 }, 'bottom');
    const moves = writes.map((y, i) => y - (i === 0 ? 0 : writes[i - 1]!));
    for (let i = 1; i < moves.length; i++) expect(moves[i]!, `frame ${i + 1}`).toBeLessThan(moves[i - 1]!);
    // Fast off the mark: over twice the even share a linear glide's first
    // frame would cover.
    expect(moves[0]!).toBeGreaterThan((2 * 4600) / writes.length);
  });

  it('returns to y=0 for "top"', async () => {
    const scroller = makeFakeScroller({ scrollTop: 3000, clientHeight: 800, scrollHeight: 5400 });
    const page = installFakeBrowser(scroller);

    await executeAction(page, { action: 'scroll', to: 'top', description: 'Back to the top' });

    expect(scroller.current()).toBe(0);
  });

  it('is a clean no-op when the page is already at the bottom', async () => {
    const scroller = makeFakeScroller({ scrollTop: 4600, clientHeight: 800, scrollHeight: 5400 });
    const page = installFakeBrowser(scroller);

    const result = await executeAction(page, { action: 'scroll', to: 'bottom', description: 'To the bottom' });

    expect(result.success).toBe(true);
    expect(scroller.current()).toBe(4600);
    // Not one frame moves the viewport — no jump to 5400, no bounce to 0.
    expect(scroller.writes.every((v) => v === 4600)).toBe(true);
  });

  it('does not move a page that has nothing to scroll', async () => {
    const scroller = makeFakeScroller({ scrollTop: 0, clientHeight: 900, scrollHeight: 900 });
    const page = installFakeBrowser(scroller);

    await executeAction(page, { action: 'scroll', to: 'bottom', description: 'To the bottom' });

    expect(scroller.current()).toBe(0);
  });

  it('still completes at the target when no frames ever arrive', async () => {
    // rAF is throttled to zero on hidden/occluded pages — the deadline timer is
    // the only thing that ends the animation there.
    const scroller = makeFakeScroller({ scrollTop: 0, clientHeight: 800, scrollHeight: 1000 });
    const page = installFakeBrowser(scroller, { frames: false });

    const result = await executeAction(page, { action: 'scroll', to: 'bottom', description: 'To the bottom' });

    expect(result.success).toBe(true);
    expect(scroller.current()).toBe(200);
    expect(scroller.writes).toEqual([200]); // one snap, no glide
  });
});

// ─── The scroll-position line ────────────────────────────────────────────────

describe('formatScrollPosition', () => {
  it('reports the visible window and the total height', () => {
    expect(formatScrollPosition({ scrollTop: 1240, clientHeight: 720, scrollHeight: 5400 }))
      .toBe('Scroll position: 1240–1960 of 5400px');
  });

  it('marks the extremes', () => {
    expect(formatScrollPosition({ scrollTop: 0, clientHeight: 720, scrollHeight: 5400 }))
      .toBe('Scroll position: 0–720 of 5400px (at top)');
    expect(formatScrollPosition({ scrollTop: 4680, clientHeight: 720, scrollHeight: 5400 }))
      .toBe('Scroll position: 4680–5400 of 5400px (at bottom)');
  });

  it('treats a fractional position within a pixel of an extreme as being at it', () => {
    expect(formatScrollPosition({ scrollTop: 4679.5, clientHeight: 720, scrollHeight: 5400 }))
      .toContain('(at bottom)');
    expect(formatScrollPosition({ scrollTop: 0.5, clientHeight: 720, scrollHeight: 5400 }))
      .toContain('(at top)');
  });

  it('says so when the page does not scroll, rather than claiming "at top"', () => {
    const line = formatScrollPosition({ scrollTop: 0, clientHeight: 900, scrollHeight: 900 });
    expect(line).toBe('Scroll position: 0–900 of 900px (page does not scroll)');
    expect(line).not.toContain('at top');
  });
});

describe('message builders — scroll-position line', () => {
  const textOf = (msg: { content: string | Array<{ type: string; text?: string }> }): string =>
    typeof msg.content === 'string'
      ? msg.content
      : msg.content.find((b) => b.type === 'text')?.text ?? '';

  it('renders the line in a step message when the position was captured', () => {
    const text = textOf(buildStepMessage('Scroll to the bottom', '<html></html>', null, [], undefined, undefined, {
      scrollTop: 1240,
      clientHeight: 720,
      scrollHeight: 5400,
    }));
    expect(text).toContain('Scroll position: 1240–1960 of 5400px');
  });

  it('omits it entirely from a step message when capture failed', () => {
    const text = textOf(buildStepMessage('Scroll to the bottom', '<html></html>', null, []));
    expect(text).not.toContain('Scroll position');
    expect(text).not.toContain('undefined');
  });

  it('renders the line directly under Current URL in a continuation message', () => {
    const text = textOf(buildContinuationMessage(
      'Scroll to the bottom',
      [],
      {},
      'https://app.example.com/feed',
      '<html></html>',
      null,
      2,
      undefined,
      undefined,
      undefined,
      { scrollTop: 4680, clientHeight: 720, scrollHeight: 5400 },
    ));
    expect(text).toContain(
      'Current URL: https://app.example.com/feed\nScroll position: 4680–5400 of 5400px (at bottom)',
    );
  });

  it('omits it entirely from a continuation message when capture failed', () => {
    const text = textOf(buildContinuationMessage(
      'Scroll to the bottom',
      [],
      {},
      'https://app.example.com/feed',
      '<html></html>',
      null,
      2,
    ));
    expect(text).not.toContain('Scroll position');
    expect(text).not.toContain('undefined');
  });
});
