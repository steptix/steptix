/**
 * What a `type` presses (steptix/steptix#90), on SecureBank's Schedule a
 * transfer page (fixtures/test-app/schedule-transfer.html).
 *
 * A `type` puts in the characters its step names and presses no key the step
 * did not ask for. SPEC-web-survey-fixes.md §2.3 used to press End after every
 * fill, so that a filter listening for keyup would see the text. On a date
 * typed into three spinbutton segments End is the key for "set to the
 * maximum", and 01/01/1982 went in as 31/12/9999 with every step passing,
 * because no step read the field back. This page has both kinds of field, and
 * its Schedule button reads every value back:
 *
 *  - a plain `type` fills: the segments hold what was typed, no key reaches a
 *    field after its value is in, and the keyup-only payee filter does not
 *    react, which is why a step that needs it has to say so;
 *  - a `type` with `sequential` (what the model sends when a step asks for
 *    its text one character at a time) types each character with its own key
 *    events, and the filter reacts.
 *
 * Where a step runs whole, the model is scripted: each step replays the reply
 * a model would give, so the result is the same on every run. The page, the
 * browser and the step loop are real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { executeAction } from '../src/browser/actions.js';
import { executeStep } from '../src/runner/step-executor.js';
import { actionsOf } from '../src/codebehind/recording.js';
import { renderReport } from '../src/report/generator.js';
import { DEFAULT_BROWSER_DIMENSIONS } from '../src/config/browser-dimensions.js';
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
  context = await browser.newContext();
}, 60_000);

afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  await server?.stop();
}, 60_000);

beforeEach(async () => {
  page = await context.newPage();
  await page.goto(`${server!.baseUrl}/schedule-transfer`);
});

afterEach(async () => {
  await page.close();
});

/** `type` `value` into `selector` through the executor, as the step loop does. */
const type = (selector: string, value: string, extra: Partial<AIAction> = {}) =>
  executeAction(page, { action: 'type', selector, value, description: `Type ${value}`, ...extra });

/**
 * Start recording every keydown and keyup `selector` receives. Returns a
 * reader for what has arrived so far, as `"<event> <key>"`.
 */
async function recordKeys(selector: string): Promise<() => Promise<string[]>> {
  await page.locator(selector).evaluate((el) => {
    const w = window as unknown as { __keys: string[] };
    w.__keys = [];
    for (const name of ['keydown', 'keyup']) {
      el.addEventListener(name, (e) => w.__keys.push(`${name} ${(e as KeyboardEvent).key}`));
    }
  });
  return () => page.evaluate(() => (window as unknown as { __keys: string[] }).__keys.slice());
}

/**
 * The keys `clear()` presses before any fill. Playwright's `clear()` is
 * `fill('')`, which selects the text and presses Delete. That clear is older
 * than End and is outside steptix/steptix#90 ("Not in this fix"), so every
 * type below starts with it; what this file pins is that nothing follows it
 * that the step did not ask for.
 */
const CLEAR_KEYS = ['keydown Delete', 'keyup Delete'];

const valueNow = (selector: string): Promise<string | null> => page.locator(selector).getAttribute('aria-valuenow');

const shownPayees = async (): Promise<string[]> =>
  (await page.locator('#payee-list label:visible').allTextContents()).map((text) => text.trim());

describe('SecureBank Schedule a transfer: the page is a fair test', () => {
  // The controls for everything below. Without them, "the segment holds 14"
  // would hold on a page where End did nothing, and "the filter did not
  // react" on a page whose filter never could.
  it('End sets a date segment to its maximum and Home to its minimum, as the spinbutton pattern says', async () => {
    await page.locator('#transfer-day').focus();
    await page.keyboard.press('End');
    expect(await valueNow('#transfer-day')).toBe('31');
    await page.keyboard.press('Home');
    expect(await valueNow('#transfer-day')).toBe('1');
    await page.locator('#transfer-year').focus();
    await page.keyboard.press('End');
    expect(await valueNow('#transfer-year')).toBe('9999');
    expect(await page.textContent('#transfer-year')).toBe('9999');
  });

  it('the payee filter reacts to keyup and to nothing else', async () => {
    await page.locator('#payee-search').fill('dent');
    expect(await shownPayees()).toHaveLength(5);
    await page.locator('#payee-search').dispatchEvent('keyup');
    expect(await shownPayees()).toEqual(['Northside Dental']);
    expect(await page.textContent('#payee-count')).toBe('1 payee');
  });
});

describe('a plain type fills, and presses no key the step did not ask for', () => {
  it('types 14, 03 and 2027 into the date segments, and each keeps what was typed', async () => {
    const segments: Array<[selector: string, typed: string, now: string]> = [
      ['#transfer-day', '14', '14'],
      ['#transfer-month', '03', '3'],
      ['#transfer-year', '2027', '2027'],
    ];
    for (const [selector, typed, now] of segments) {
      const result = await type(selector, typed);
      expect(result.success, selector).toBe(true);
      expect(await valueNow(selector), selector).toBe(now);
      expect(await page.textContent(selector), selector).toBe(typed);
      // Nothing to report about how a plain type typed: it filled.
      expect(result.typed, selector).toBeUndefined();
    }
  });

  it('01 into the day leaves it 1, with no key after the value: End made it 31 (steptix/steptix#90)', async () => {
    const keys = await recordKeys('#transfer-day');
    expect((await type('#transfer-day', '01')).success).toBe(true);
    expect(await valueNow('#transfer-day')).toBe('1');
    expect(await page.getAttribute('#transfer-day', 'aria-valuetext')).toBe('01');
    expect(await keys()).toEqual(CLEAR_KEYS);
  });

  it('leaves a keyup-only filter as it was: such a page needs a step that asks for key by key', async () => {
    const keys = await recordKeys('#payee-search');
    expect((await type('#payee-search', 'dent')).success).toBe(true);
    expect(await page.inputValue('#payee-search')).toBe('dent');
    expect(await shownPayees()).toHaveLength(5);
    expect(await keys()).toEqual(CLEAR_KEYS);
  });
});

describe('a key-by-key type, when the step asks for one', () => {
  it('types each character with its own key events, and the keyup-only filter sees them', async () => {
    const keys = await recordKeys('#payee-search');
    const result = await type('#payee-search', 'dent', { sequential: true });
    expect(result.success).toBe(true);
    expect(result.typed).toEqual({ by: 'keys' });
    expect(await page.inputValue('#payee-search')).toBe('dent');
    expect(await shownPayees()).toEqual(['Northside Dental']);
    expect(await keys()).toEqual([
      ...CLEAR_KEYS,
      'keydown d', 'keyup d', 'keydown e', 'keyup e', 'keydown n', 'keyup n', 'keydown t', 'keyup t',
    ]);
  });

  it('replaces what the field held, as a plain type does', async () => {
    expect((await type('#payee-search', 'harbour')).success).toBe(true);
    expect((await type('#payee-search', 'hill', { sequential: true })).success).toBe(true);
    expect(await page.inputValue('#payee-search')).toBe('hill');
    expect(await shownPayees()).toEqual(['Hilltop Veterinary']);
  });

  it('types the digits into a date segment, and still presses no End', async () => {
    const keys = await recordKeys('#transfer-day');
    const result = await type('#transfer-day', '01', { sequential: true });
    expect(result.success).toBe(true);
    expect(result.typed).toEqual({ by: 'keys' });
    expect(await valueNow('#transfer-day')).toBe('1');
    expect(await keys()).toEqual([...CLEAR_KEYS, 'keydown 0', 'keyup 0', 'keydown 1', 'keyup 1']);
  });
});

// ── The whole transfer, one step at a time ──────────────────────────────────

const reply = (actions: Record<string, unknown>[]): string => JSON.stringify({ actions, reasoning: 'scripted' });

/** Run one step with the model's single reply scripted. */
async function runStep(index: number, total: number, instruction: string, action: Record<string, unknown>): Promise<StepResult> {
  const queue = [reply([{ description: instruction, ...action }])];
  const complete = vi.fn(async () => {
    const text = queue.shift();
    if (text === undefined) throw new Error(`the script for "${instruction}" has no reply left`);
    return { text, model: 'scripted' };
  });
  return executeStep(index, total, instruction, {
    page,
    config: {
      ai: { gatewayUrl: '', model: 'scripted', maxInputTokens: 1000, streamResponses: false },
      browser: { headed: false, viewport: { ...DEFAULT_BROWSER_DIMENSIONS }, windowSize: { ...DEFAULT_BROWSER_DIMENSIONS }, slowMo: 0, browser: 'chromium', fullPageScreenshots: false },
      tests: { dir: '.', contextDir: '.', pattern: '**/*.md' },
      execution: { timeout: 30000, retries: 1, screenshotOnFailure: false, promptOnAmbiguity: false, maxTurns: 3 },
      reports: { outputDir: '.', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: true },
      api: { specsDir: '.', requestTimeout: 5000, redactSensitive: false },
    } as never,
    aiClient: { complete } as never,
    contextContent: '',
    testName: 'Schedule a transfer',
    conversationHistory: [],
    csrfTokens: {},
  });
}

function reportOf(steps: StepResult[]): TestReport {
  return {
    testName: 'schedule-transfer',
    filePath: path.resolve(path.sep, 'p', 'tests', 'schedule-transfer.md'),
    tags: [],
    status: 'passed',
    steps,
    totalSteps: steps.length,
    passedSteps: steps.length,
    failedSteps: 0,
    totalSubActions: steps.length,
    durationMs: 1,
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    date: new Date(0).toISOString(),
  };
}

describe('the whole transfer, with the model scripted', () => {
  it('schedules it, and the confirmation reads back every value the steps typed', async () => {
    const steps: Array<[instruction: string, action: Record<string, unknown>]> = [
      ['Type "dent" into the Find a payee box one character at a time',
        { action: 'type', selector: '#payee-search', value: 'dent', sequential: true }],
      ['Choose Northside Dental', { action: 'click', selector: 'input[value="Northside Dental"]' }],
      ['Type 25.00 into the Amount field', { action: 'type', selector: '#amount', value: '25.00' }],
      ['Type 14 into the day of the Transfer date', { action: 'type', selector: '#transfer-day', value: '14' }],
      ['Type 03 into the month of the Transfer date', { action: 'type', selector: '#transfer-month', value: '03' }],
      ['Type 2027 into the year of the Transfer date', { action: 'type', selector: '#transfer-year', value: '2027' }],
      ['Click Schedule transfer', { action: 'click', selector: '#schedule-transfer' }],
    ];
    const results: StepResult[] = [];
    for (const [i, [instruction, action]] of steps.entries()) {
      const result = await runStep(i + 1, steps.length, instruction, action);
      expect(result.status, instruction).toBe('passed');
      results.push(result);
      if (i === 0) expect(await shownPayees()).toEqual(['Northside Dental']);
    }
    expect(await page.textContent('#confirmation-text')).toBe('$25.00 to Northside Dental on 14/03/2027');

    // The flag the model sent reaches the recording a compile reads, with how
    // the runtime typed; a plain type carries neither.
    const [filtered] = actionsOf(results[0]);
    expect(filtered).toMatchObject({ action: 'type', sequential: true, typed: { by: 'keys' } });
    const [day] = actionsOf(results[3]);
    expect(day!.sequential).toBeUndefined();
    expect(day!.typed).toBeUndefined();

    // And the report says which way each field was typed.
    const filteredHtml = renderReport(reportOf([results[0]!]));
    expect(filteredHtml).toContain('typed key by key');
    expect(renderReport(reportOf([results[3]!]))).not.toContain('key by key');
  });
});
