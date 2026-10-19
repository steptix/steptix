/**
 * An HTML5 drag that could not have dropped anywhere fails instead of passing
 * (docs/specs/SPEC-web-survey-fixes.md §2.52, steptix/steptix#92).
 *
 * In the survey, a page moved its content off screen while a drag ran: the
 * drag started, the drop zone never received a `dragover`, nothing was
 * dropped, and the drag reported success. Only the check after it noticed.
 * The SecureBank File receipts page (`fixtures/test-app/file-receipts.html`)
 * does the same on request: `?move=on-drag` moves its content off screen
 * once, as the first drag gets under way; `?move=every-drag` during every
 * drag; `?move=every-press` whenever a receipt is pressed; `?move=in-dragstart`
 * in every dragstart handler, which makes Chromium give the drag up as it
 * begins; `?move=in-first-dragstart` in the first one only.
 *
 * Nothing here waits on time: each drag is awaited, and what the page did is
 * read from the page afterwards.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { DragStalledError, executeAction, untilDragStalls } from '../src/browser/actions.js';
import { renderReport } from '../src/report/generator.js';
import { addLogCallback } from '../src/utils/logger.js';
import type { AIAction } from '../src/ai/types.js';
import type { StepResult, TestReport } from '../src/report/types.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

let server: FixtureServer | undefined;
let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
}, 60_000);

afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  await server?.stop();
}, 60_000);

beforeEach(async () => {
  page = await context.newPage();
});

afterEach(async () => {
  await page.close();
});

const drag: AIAction = {
  action: 'drag',
  selector: '#receipts span:text-is("Receipt 1043")',
  target: '#tax-folder',
  description: 'Drag Receipt 1043 onto the Tax folder',
};

/**
 * Move the page's content another 3000px to the right just before the mouse
 * is pressed: before every press, or before the first `times` of them.
 */
function moveBeforeEachPress(target: Page, times = Infinity): void {
  const down = target.mouse.down.bind(target.mouse);
  let presses = 0;
  target.mouse.down = async (...args) => {
    if (presses++ < times) {
      await target.evaluate((n) => {
        document.getElementById('filing')!.style.marginLeft = `${3000 * n}px`;
      }, presses);
    }
    return down(...args);
  };
}

/** What the page shows once the drag is over. */
const filed = () => page.locator('#filed-list li').allTextContents();
const waiting = () => page.locator('#receipts span').allTextContents();

describe('an HTML5 drag onto a drop zone', () => {
  it('drops the receipt, and says it went by the stepped mouse drag', async () => {
    await page.goto(`${server!.baseUrl}/file-receipts`);
    const lines: string[] = [];
    const stop = addLogCallback((_level, message) => lines.push(message));
    let result;
    try {
      result = await executeAction(page, drag);
    } finally {
      stop();
    }
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.drag).toEqual({ via: 'stepped' });
    expect(await filed()).toEqual(['Receipt 1043']);
    expect(await waiting()).toEqual(['Receipt 1044']);
    // The run log names the route, and what the drag watch saw.
    expect(lines.some((l) => l.includes('drag via stepped mouse moves'))).toBe(true);
    expect(lines.some((l) => l.includes('press on the source, dragstart yes, dragover on the target yes, taken by the page yes, drop yes'))).toBe(true);
  }, 30_000);

  it('drags again when the page moved the pair during the first drag, and drops', async () => {
    // The page moves its content off screen once the first drag is under
    // way, as a page that loads a widget on first interaction would. The
    // first drag reaches nothing; nothing was dropped, so a second one from
    // where the pair is now is safe, and it lands.
    await page.goto(`${server!.baseUrl}/file-receipts?move=on-drag`);
    const lines: string[] = [];
    const stop = addLogCallback((_level, message) => lines.push(message));
    let result;
    try {
      result = await executeAction(page, drag);
    } finally {
      stop();
    }
    expect(result.error).toBeUndefined();
    expect(result.drag).toEqual({ via: 'stepped' });
    expect(await filed()).toEqual(['Receipt 1043']);
    expect(lines).toContain(
      'drag: the page moved the source and the target while the drag ran and nothing was dropped; dragging again from where they are now',
    );
    expect(lines.filter((l) => l.startsWith('drag events (via stepped)'))).toEqual([
      'drag events (via stepped): press on the source, dragstart yes, dragover on the target no, taken by the page no, drop no',
      'drag events (via stepped): press on the source, dragstart yes, dragover on the target yes, taken by the page yes, drop yes',
    ]);
  }, 30_000);
});

describe('an HTML5 drag that could not drop', () => {
  it('fails when the drop zone never receives a dragover, saying so', async () => {
    // The page moves its content off screen during every drag, so the
    // pointer heads for where the folder was and finds nothing there, the
    // second time as well as the first.
    await page.goto(`${server!.baseUrl}/file-receipts?move=every-drag`);
    const result = await executeAction(page, drag);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(
      /^The drag did not reach "#tax-folder": the page started a drag, but "#tax-folder" never received a dragover, so the browser had nowhere to drop it and nothing was dropped \(via stepped\)\./,
    );
    expect(result.error).toMatch(/"#tax-folder" is now at \(\d+, \d+\), \d+×\d+, off screen\./);
    expect(result.error).toMatch(/If the page moved while the drag ran, drag again\.$/);
    // Nothing moved, which is what the failure says.
    expect(await filed()).toEqual([]);
    expect(await waiting()).toEqual(['Receipt 1043', 'Receipt 1044']);
    // The watch is taken down whichever way the drag ends.
    expect(await page.evaluate(() => '__steptixDragWatch' in globalThis)).toBe(false);
  }, 30_000);

  it('fails when the browser starts no drag from a draggable receipt, saying so', async () => {
    // The page moves its content whenever the receipt is pressed: the
    // receipt is no longer under the pointer, and the browser starts no drag.
    await page.goto(`${server!.baseUrl}/file-receipts?move=every-press`);
    const result = await executeAction(page, drag);
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'The drag never started: "#receipts span:text-is("Receipt 1043")" is draggable (draggable="true"), but the '
      + 'browser started no drag after the press, so nothing was dropped (via stepped). That happens when the page '
      + 'moves the element out from under the pointer as it is pressed. Drag again.',
    );
    expect(await filed()).toEqual([]);
  }, 30_000);

  it('fails when the page moves the receipt between the pointer reaching it and the press, saying so', async () => {
    // On the survey the move most likely came from a widget that loads once
    // the pointer touches the page, and it landed between the check that the
    // pointer reaches the source and the press (seen in a live c58 run). Here the move is made just before
    // every press, which is the same order without the race.
    await page.goto(`${server!.baseUrl}/file-receipts`);
    moveBeforeEachPress(page);
    const result = await executeAction(page, drag);
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'The drag never started: the press meant for "#receipts span:text-is("Receipt 1043")" landed on html '
      + 'instead, so nothing was dragged (via stepped). The page moved "#receipts span:text-is("Receipt 1043")", '
      + 'or put something over it, after the pointer reached it. Drag again.',
    );
    expect(await filed()).toEqual([]);
  }, 30_000);

  it('drags again when the page moved the receipt before the first press only, and drops', async () => {
    await page.goto(`${server!.baseUrl}/file-receipts`);
    moveBeforeEachPress(page, 1);
    const result = await executeAction(page, drag);
    expect(result.error).toBeUndefined();
    expect(await filed()).toEqual(['Receipt 1043']);
  }, 30_000);

  it('fails when dragTo has to scroll between the press and the folder, saying why', async () => {
    // A window too short to show the receipt and the folder together, so the
    // stepped drag hands over to dragTo (§2.19). dragTo scrolls the folder
    // into view after pressing, the receipt is no longer under the press,
    // and the browser starts no drag. This used to pass with nothing moved.
    await page.setViewportSize({ width: 1280, height: 200 });
    try {
      await page.goto(`${server!.baseUrl}/file-receipts`);
      await page.evaluate(() => { document.getElementById('tax-folder')!.style.marginTop = '600px'; });
      const result = await executeAction(page, drag);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        /^The drag never started: .* \(via dragTo\)\. `dragTo` scrolls the page to reach the target after the press/,
      );
      expect(await filed()).toEqual([]);
    } finally {
      await page.setViewportSize({ width: 1280, height: 720 });
    }
  }, 30_000);

  it('does not drag again when something in the page already took the drag', async () => {
    // The receipts list offers to take the drop (cancels dragover), as a
    // sortable that reorders while the pointer passes does. The page then
    // moves as in the on-drag case, so the folder gets no dragover. A second
    // drag could repeat whatever the list did with the first, so it fails.
    await page.goto(`${server!.baseUrl}/file-receipts?move=on-drag`);
    await page.evaluate(() => {
      document.getElementById('receipts')!.addEventListener('dragover', (e) => e.preventDefault());
    });
    const lines: string[] = [];
    const stop = addLogCallback((_level, message) => lines.push(message));
    let result;
    try {
      result = await executeAction(page, drag);
    } finally {
      stop();
    }
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^The drag did not reach "#tax-folder"/);
    expect(lines.some((l) => l.includes('dragging again'))).toBe(false);
    expect(await filed()).toEqual([]);
  }, 30_000);

  it('passes a drag whose drop the page took on a layer it put over the folder', async () => {
    // Some pages show a full-size drop layer once a drag starts and handle
    // the drop there. The folder never gets a dragover, but a drop happened,
    // so this is not a drag that could not drop; the next Verify judges it.
    await page.goto(`${server!.baseUrl}/file-receipts`);
    await page.evaluate(() => {
      document.addEventListener('dragstart', () => {
        const layer = document.createElement('div');
        layer.id = 'drop-layer';
        layer.style.cssText = 'position:fixed;inset:0;z-index:10';
        layer.addEventListener('dragover', (e) => e.preventDefault());
        layer.addEventListener('drop', (e) => {
          e.preventDefault();
          const item = document.createElement('li');
          item.textContent = e.dataTransfer!.getData('text/plain');
          document.getElementById('filed-list')!.appendChild(item);
          layer.remove();
        });
        // After dragstart, so the browser starts the drag from the receipt.
        setTimeout(() => document.body.appendChild(layer), 0);
      }, { once: true });
    });
    const result = await executeAction(page, drag);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(await filed()).toEqual(['Receipt 1043']);
  }, 30_000);

  it('takes the watch down when the drag itself throws', async () => {
    await page.goto(`${server!.baseUrl}/file-receipts`);
    const move = page.mouse.move.bind(page.mouse);
    let moves = 0;
    page.mouse.move = async (...args) => {
      // The pointer check's two moves pass; the first move of the drag throws.
      if (++moves === 3) throw new Error('mouse move under test failed');
      return move(...args);
    };
    const result = await executeAction(page, drag);
    expect(result.success).toBe(false);
    expect(result.error).toContain('mouse move under test failed');
    expect(await page.evaluate(() => '__steptixDragWatch' in globalThis)).toBe(false);
  }, 30_000);

  it('passes a drag the page runs on its own, with no HTML5 drag at all', async () => {
    // The control for the rule above: a pointer-event drag never fires a
    // dragstart, and its target never sees a dragover. That is not a drag
    // that failed to drop; whether it worked is for the next Verify.
    await page.goto(`${server!.baseUrl}/file-receipts`);
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('#receipts span')) el.removeAttribute('draggable');
    });
    const result = await executeAction(page, drag);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(await filed()).toEqual([]);
  }, 30_000);
});

describe('a drag the browser gives up as it begins', () => {
  // The page moves (or removes) the receipt in its own dragstart handler.
  // Chromium then gives the drag up at once (a dragend straight after the
  // dragstart), and Playwright's mouse move waits for the drag forever:
  // before this fix, the action never returned. Each test here ends when the drag does;
  // nothing waits on time.

  /** Count the mouse releases that reach the page from now on. */
  const countReleases = () => page.evaluate(() => {
    (globalThis as any).releases = 0;
    addEventListener('mouseup', () => { (globalThis as any).releases += 1; }, true);
  });
  const releases = () => page.evaluate(() => (globalThis as any).releases as number);

  it('fails saying the browser gave the drag up, and lets go of the button', async () => {
    await page.goto(`${server!.baseUrl}/file-receipts?move=in-dragstart`);
    await countReleases();
    const lines: string[] = [];
    const stop = addLogCallback((_level, message) => lines.push(message));
    let result;
    try {
      result = await executeAction(page, drag);
    } finally {
      stop();
    }
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'The drag never got going: the browser started a drag from "#receipts span:text-is("Receipt 1043")" and gave '
      + 'it up at once, before it reached anything, so nothing was dropped (via stepped). Chromium does that when '
      + 'the page moves, hides or removes the element as the drag starts.',
    );
    // Nothing was dropped, so it dragged once more from where the page put
    // the receipt, and the page gave that one up too.
    expect(lines.filter((l) => l === 'drag via stepped mouse moves')).toHaveLength(2);
    expect(await filed()).toEqual([]);
    expect(await waiting()).toEqual(['Receipt 1043', 'Receipt 1044']);
    // Each press was let go, and the watch is down.
    expect(await releases()).toBe(2);
    expect(await page.evaluate(() => '__steptixDragWatch' in globalThis)).toBe(false);
  }, 30_000);

  it('fails the same way when the dragstart handler removes the receipt', async () => {
    // A removed receipt is the only one to hear its dragend: the window does
    // not, so the watch listens on the receipt too.
    await page.goto(`${server!.baseUrl}/file-receipts`);
    await page.evaluate(() => {
      for (const receipt of document.querySelectorAll('#receipts span')) {
        receipt.addEventListener('dragstart', () => receipt.remove());
      }
    });
    const result = await executeAction(page, drag);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^The drag never got going: .* \(via stepped\)\./);
  }, 30_000);

  it('drags again when only the first dragstart moved the receipt, and drops', async () => {
    // The mouse move the first drag left waiting does not get in the way of
    // the second.
    await page.goto(`${server!.baseUrl}/file-receipts?move=in-first-dragstart`);
    const result = await executeAction(page, drag);
    expect(result.error).toBeUndefined();
    expect(result.drag).toEqual({ via: 'stepped' });
    expect(await filed()).toEqual(['Receipt 1043']);
  }, 30_000);

  it('fails the same way by dragTo, and lets go of the button', async () => {
    // dragTo takes over when the window looks too small for the pair (§2.19).
    // Only the drag's own read of the window size is made small, so dragTo
    // moves without scrolling and the dragstart handler is what stops it.
    await page.goto(`${server!.baseUrl}/file-receipts?move=in-dragstart`);
    await countReleases();
    const evaluate = page.evaluate.bind(page) as (...args: unknown[]) => Promise<unknown>;
    (page as any).evaluate = (fn: unknown, ...rest: unknown[]) => (
      String(fn).includes('innerWidth') ? Promise.resolve({ width: 1, height: 1 }) : evaluate(fn, ...rest)
    );
    const result = await executeAction(page, drag);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^The drag never got going: .* \(via dragTo\)\./);
    expect(await filed()).toEqual([]);
    expect(await releases()).toBe(1);
    expect(await page.evaluate(() => '__steptixDragWatch' in globalThis)).toBe(false);
  }, 30_000);
});

describe('untilDragStalls', () => {
  // The ceiling for a drag the watch cannot follow. Fake timers, so the
  // budget passes without anyone waiting for it.
  afterEach(() => { vi.useRealTimers(); });

  it('returns what the input returns', async () => {
    await expect(untilDragStalls(Promise.resolve('moved'), new Promise(() => {}), 5_000)).resolves.toBe('moved');
  });

  it('fails as given up when the watch hears the browser give the drag up', async () => {
    const stalled = untilDragStalls(new Promise(() => {}), Promise.resolve(true), 5_000);
    await expect(stalled).rejects.toBeInstanceOf(DragStalledError);
    await expect(stalled).rejects.toMatchObject({ gaveUp: true });
  });

  it('fails as out of time once the budget and a moment more have passed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The watch could not tell (null), so only the budget ends the wait.
    const stalled = untilDragStalls(new Promise(() => {}), Promise.resolve(null), 5_000);
    const settled = stalled.then(() => 'returned', (err: unknown) => err);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await settled;
    expect(err).toBeInstanceOf(DragStalledError);
    expect(err).toMatchObject({ gaveUp: false, waitedMs: 6_000 });
  });
});

describe('the report', () => {
  function reportOf(sub: StepResult['subActions'][number]): TestReport {
    const step = {
      index: 1,
      instruction: 'Drag Receipt 1043 onto the Tax folder',
      status: 'passed',
      subActions: [sub],
      turns: [{ turnNumber: 1, attemptNumber: 1, timestamp: new Date(0).toISOString(), aiInteractions: [], subActions: [sub] }],
      durationMs: 1,
    } as unknown as StepResult;
    return {
      testName: 'file-receipts',
      filePath: path.resolve(path.sep, 'p', 'tests', 'file-receipts.md'),
      tags: [],
      status: 'passed',
      steps: [step],
      totalSteps: 1,
      passedSteps: 1,
      failedSteps: 0,
      totalSubActions: 1,
      durationMs: 1,
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      date: new Date(0).toISOString(),
    };
  }

  it('names the route on the drag row', () => {
    const row = (via?: 'stepped' | 'dragTo') => renderReport(reportOf({
      index: 1, action: { ...drag, selector: '#a', target: '#b' }, durationMs: 1,
      ...(via !== undefined && { drag: { via } }),
    }));
    expect(row('stepped')).toContain('<div class="sub-action-detail">dragged: #a → onto: #b (via stepped mouse moves)</div>');
    expect(row('dragTo')).toContain('<div class="sub-action-detail">dragged: #a → onto: #b (via dragTo)</div>');
    // A failed drag carries no route; its error names it.
    expect(row()).toContain('<div class="sub-action-detail">dragged: #a → onto: #b</div>');
  });
});
