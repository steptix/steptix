import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { executeAction } from '../src/browser/actions.js';
import { parseAIResponse } from '../src/ai/action-parser.js';
import { buildSystemPrompt, buildStepCodePrompt, contentBlocksToText } from '../src/ai/prompts.js';
import { logger } from '../src/utils/logger.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `back` and `forward` touch nothing but the page's own history methods — no
 * selector of their own — so the mock is the one the navigate test uses, plus
 * the two members `executeAction` reaches for while resolving a frame on the
 * way to any action (§4.2's case).
 */
function makeMockPage(back: unknown = {}, forward: unknown = {}) {
  const goBack = vi.fn().mockResolvedValue(back);
  const goForward = vi.fn().mockResolvedValue(forward);
  // `executeAction` resolves the frame root once for every action, before it
  // dispatches, so this is called even for an action that ignores it. It
  // answers with a stub rather than throwing: what this file pins is that the
  // HISTORY call landed on the page (a FrameLocator has no goBack at all, so
  // passing the root instead would not compile).
  // `executeAction` resolves and validates the frame root for EVERY action
  // before it dispatches, so both of these are reached even by an action that
  // ignores the frame. They answer with stubs rather than throwing: what this
  // file pins is that the history call landed on the PAGE — and a FrameLocator
  // has no `goBack` at all, so passing the root instead would not compile.
  const frameLocator = vi.fn(() => ({ locator: () => ({ count: async () => 1 }) }));
  const locator = vi.fn(() => ({ count: async () => 1 }));
  const page = {
    goBack,
    goForward,
    frameLocator,
    locator,
    url: () => 'https://app.test/second',
  } as unknown as Page;
  return { page, goBack, goForward, frameLocator };
}

describe("back and forward — the browser's own history (SPEC-browser-history.md §4)", () => {
  it('calls goBack on the page, and reports success', async () => {
    const { page, goBack, goForward } = makeMockPage();
    const result = await executeAction(page, { action: 'back', description: 'Go back to the list' });
    expect(result.success).toBe(true);
    expect(goBack).toHaveBeenCalledTimes(1);
    expect(goForward).not.toHaveBeenCalled();
  });

  it('calls goForward for the forward action', async () => {
    const { page, goBack, goForward } = makeMockPage();
    const result = await executeAction(page, { action: 'forward', description: 'Forward again' });
    expect(result.success).toBe(true);
    expect(goForward).toHaveBeenCalledTimes(1);
    expect(goBack).not.toHaveBeenCalled();
  });

  /**
   * §4.2. A run that has switched into an iframe must still move the whole
   * tab, so the dispatch hands `executeHistory` the page and not the resolved
   * frame root — even when the action itself carries a `frame`.
   */
  it('acts on the page even when the action names a frame', async () => {
    const { page, goBack } = makeMockPage();
    const result = await executeAction(page, {
      action: 'back',
      frame: 'iframe#checkout',
      description: 'Go back out of the checkout frame',
    });
    expect(result.success).toBe(true);
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  /**
   * §4.3, and the reason this action exists at all. Playwright answers `null`
   * when there is no entry to move to, which is a silent no-op — and a silent
   * no-op reported as success is the measured defect of §2, where a step asked
   * for the browser's back button, got a keypress delivered to the focused
   * element, and passed without moving.
   */
  it('FAILS when there is no previous page, rather than passing silently', async () => {
    const { page } = makeMockPage(null);
    const result = await executeAction(page, { action: 'back', description: 'Go back' });
    expect(result.success).toBe(false);
    expect(result.error).toBe("back: the browser has no previous page in this tab's history");
  });

  it('FAILS the same way when there is no page ahead', async () => {
    const { page } = makeMockPage({}, null);
    const result = await executeAction(page, { action: 'forward', description: 'Go forward' });
    expect(result.success).toBe(false);
    expect(result.error).toBe("forward: the browser has no page ahead in this tab's history");
  });
});

describe('back and forward — the parser (§4.1)', () => {
  it('accepts both actions with only a description', () => {
    for (const action of ['back', 'forward'] as const) {
      const parsed = parseAIResponse(JSON.stringify({ action, description: 'move' }));
      expect(parsed.actions).toHaveLength(1);
      expect(parsed.actions[0]!.action).toBe(action);
      expect(parsed.actions[0]!.description).toBe('move');
    }
  });

  /**
   * The list the parser validates against is its own pin: an unknown action
   * type is KEPT verbatim and only warned about, then executed as a no-op that
   * reports success — so without this, deleting `back` from
   * `VALID_ACTION_TYPES` changes nothing any other test can see.
   */
  it('are known action types, so the parser does not warn about them', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      for (const action of ['back', 'forward'] as const) {
        parseAIResponse(JSON.stringify({ action, description: 'move' }));
      }
      const unknown = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('Unknown action type'));
      expect(unknown).toEqual([]);

      // The control: a genuinely unknown type DOES warn, so the assertion
      // above is about these two and not about the spy never firing.
      parseAIResponse(JSON.stringify({ action: 'rewind', description: 'move' }));
      expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes('Unknown action type'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not require a url, a selector or a value', () => {
    const only = parseAIResponse(JSON.stringify({ action: 'back', description: 'Go back' })).actions[0]!;
    expect(only.url).toBeUndefined();
    expect(only.selector).toBeUndefined();
    expect(only.value).toBeUndefined();
  });
});

describe('back and forward — the settle (§4.4)', () => {
  /**
   * A source assertion rather than a behavioural one: `MUTATING_ACTIONS` is
   * module-private, and what matters is that these two sit in it, so the app
   * gets the same settle a navigate gets. Reading the source is what catches a
   * later edit that adds an action and forgets these.
   */
  it('are mutating actions, so a post-action settle runs', () => {
    const source = readFileSync(path.join(repoRoot, 'src', 'runner', 'step-executor.ts'), 'utf8');
    const block = /const MUTATING_ACTIONS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source);
    expect(block, 'could not read MUTATING_ACTIONS out of step-executor.ts').not.toBeNull();
    expect(block![1]).toContain("'back'");
    expect(block![1]).toContain("'forward'");
  });
});

describe('back and forward — the prompts (§6, §7)', () => {
  it('the system prompt names both actions and rules out a keypress', () => {
    const text = contentBlocksToText(buildSystemPrompt(''));
    expect(text).toContain('"action": "back"');
    expect(text).toContain('"action": "forward"');
    // The negative is the load-bearing half: without it the model reaches for
    // the shortcut, which is exactly what §2 measured.
    expect(text.toLowerCase()).toContain('keypress');
    expect(text).toMatch(/focused element/i);
  });

  it('tells the code generator which Playwright call a recorded history action becomes', () => {
    const withHistory = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'Go back',
        parameters: [],
        actions: [{ action: 'back', description: 'Go back to the list' }],
      }).content,
    );
    expect(withHistory).toContain('page.goBack()');
    expect(withHistory).toContain('page.goForward()');

    // Conditional, like the tab rule beside it: a transcript that never moved
    // through the history does not pay for the rule on every compile. Without
    // this half the assertion above passes on a constant.
    const withoutHistory = contentBlocksToText(
      buildStepCodePrompt({
        rawStepText: 'Click Sign in',
        parameters: [],
        actions: [{ action: 'click', selector: '#signin', description: 'Click Sign in' }],
      }).content,
    );
    expect(withoutHistory).not.toContain('page.goBack()');
  });

  /**
   * §11.7 proper: the compile path must not DECLINE a history action. The
   * refusal list is for actions that cannot become code (a prompt waits on a
   * person); `back` becomes one line of Playwright.
   */
  it('does not treat a history action as one that cannot be compiled', () => {
    const source = readFileSync(path.join(repoRoot, 'src', 'codebehind', 'generate.ts'), 'utf8');
    const at = source.indexOf('const FRAMEWORK_ACTIONS');
    expect(at, 'could not find FRAMEWORK_ACTIONS in generate.ts').toBeGreaterThan(-1);
    const line = source.slice(at, source.indexOf('\n', at));
    // The refusal list is for actions that cannot become code at all. A
    // history move becomes one line of Playwright, so it must stay out.
    expect(line).not.toContain('back');
    expect(line).not.toContain('forward');
  });
});

/**
 * The mocked tests above cannot reach the defect review found here, because
 * the defect was a wrong model of what Playwright RETURNS: `goBack` resolves
 * `null` whenever the move produced no HTTP response, which is every
 * same-document move, not only an empty history. A mock that answers `null`
 * cannot tell those two apart — only a real browser can. Hence a real one.
 *
 * Measured against the first cut: the `pushState` case came back
 * `success: false` with "the browser has no previous page", having moved the
 * tab from `?view=2` to the bare path. That is the single-page-app case §2
 * names as a reason to have the action at all.
 */
describe('back and forward over a real page (§4.3, the same-document cases)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  /**
   * A page on a REAL origin, served by request interception rather than by a
   * server. `setContent` will not do: it leaves the tab on `about:blank`,
   * where the origin is null, so `pushState` throws a SecurityError and no
   * history entry is created at all — both of which hide exactly the cases
   * this block exists to cover.
   */
  async function pageOnAnOrigin(): Promise<Page> {
    const fresh = await browser.newPage();
    await fresh.route('**/*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h1>' + new URL(route.request().url()).pathname + '</h1></body></html>',
      }),
    );
    await fresh.goto('http://history.test/one');
    return fresh;
  }

  it('SUCCEEDS on a history.pushState entry, which returns no response', async () => {
    const page = await pageOnAnOrigin();
    const start = page.url();
    await page.evaluate(() => history.pushState({ view: 'two' }, '', '?view=2'));
    expect(page.url()).not.toBe(start);

    const result = await executeAction(page, { action: 'back', description: 'Go back' });
    expect(result.success).toBe(true);
    expect(page.url()).toBe(start);
    await page.close();
  });

  it('SUCCEEDS on a #hash entry, which also returns no response', async () => {
    const page = await pageOnAnOrigin();
    const start = page.url();
    await page.evaluate(() => { location.hash = '#settings'; });
    expect(page.url()).toContain('#settings');

    const result = await executeAction(page, { action: 'back', description: 'Go back' });
    expect(result.success).toBe(true);
    expect(page.url()).toBe(start);
    await page.close();
  });

  /**
   * Two entries at the same url, differing only in what the app stored. The
   * url alone says "nothing moved" here, which is why the position compared
   * is the url AND the history state.
   */
  it('SUCCEEDS between two entries at the same url with different state', async () => {
    const page = await pageOnAnOrigin();
    await page.evaluate(() => {
      history.pushState({ v: 1 }, '', location.pathname);
      history.pushState({ v: 2 }, '', location.pathname);
    });
    expect(await page.evaluate(() => (history.state as { v: number }).v)).toBe(2);

    const result = await executeAction(page, { action: 'back', description: 'Go back' });
    expect(result.success).toBe(true);
    expect(await page.evaluate(() => (history.state as { v: number }).v)).toBe(1);
    await page.close();
  });

  it('SUCCEEDS on an ordinary cross-document move, and comes back forward', async () => {
    const page = await pageOnAnOrigin();
    const first = page.url();
    await page.goto('http://history.test/two');

    expect((await executeAction(page, { action: 'back', description: 'back' })).success).toBe(true);
    expect(page.url()).toBe(first);
    expect((await executeAction(page, { action: 'forward', description: 'forward' })).success).toBe(true);
    expect(await page.textContent('h1')).toBe('/two');
    await page.close();
  });

  /**
   * The one case that must still fail — and fail without offering a retry,
   * because re-planning cannot conjure a history entry and the re-ask invites
   * a `navigate` or a `noop` that would turn the loud failure back into the
   * quiet pass this action exists to prevent.
   */
  it('FAILS, non-retryably, on a tab with nothing behind it', async () => {
    const fresh = await browser.newPage();
    const result = await executeAction(fresh, { action: 'back', description: 'Go back' });
    expect(result.success).toBe(false);
    expect(result.error).toBe("back: the browser has no previous page in this tab's history");
    expect(result.retryable).toBe(false);
    await fresh.close();
  });

  it('FAILS the same way going forward from the newest entry', async () => {
    const page = await pageOnAnOrigin();
    const result = await executeAction(page, { action: 'forward', description: 'Go forward' });
    expect(result.success).toBe(false);
    expect(result.error).toBe("forward: the browser has no page ahead in this tab's history");
    expect(result.retryable).toBe(false);
    await page.close();
  });
});

/**
 * The parser keeps an UNKNOWN action type verbatim, warns, and then the
 * executor runs it as a no-op that reports success — so a near-miss spelling
 * is the §2 defect through a different door, and `goBack` is the likeliest
 * miss of all: it is the Playwright call the code-generation prompt teaches.
 */
describe('back and forward — the spellings a model reaches for (§4.1)', () => {
  const warn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  it.each([
    ['goBack', 'back'],
    ['go_back', 'back'],
    ['browserBack', 'back'],
    ['navigateBack', 'back'],
    ['historyBack', 'back'],
    ['goForward', 'forward'],
    ['go_forward', 'forward'],
    ['browserForward', 'forward'],
    ['navigateForward', 'forward'],
    ['historyForward', 'forward'],
  ])('normalises %s to %s', (spelled, canonical) => {
    const spy = warn();
    try {
      const parsed = parseAIResponse(JSON.stringify({ action: spelled, description: 'move' }));
      expect(parsed.actions[0]!.action).toBe(canonical);
    } finally {
      spy.mockRestore();
    }
  });
});
