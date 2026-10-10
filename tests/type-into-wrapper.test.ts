/**
 * A `type` aimed at a field's wrapper (steptix/steptix#34), on SecureBank's
 * Open an account page (fixtures/test-app/signup.html).
 *
 * The page puts each field's data-testid on its wrapper <div>, not on its
 * <input>, as component libraries often do, and the action prompt ranks
 * data-testid first, so a model can aim `type` at the wrapper. `fill` refuses
 * a <div>, so the §2.27 fallback clicks it and types on the keyboard. The
 * wrapper's middle is its hint text, which takes no focus. Before the fix, the
 * click left the focus on <body>, Ctrl+A selected the page, the address was
 * typed into nothing (its `s` set off the page's search shortcut, and the `t`
 * after it landed in the search box), and the step passed. The Email case then
 * failed at the last step, far from its cause; the optional delivery field
 * passed the whole test with nothing in it.
 *
 * The model is scripted: each step replays the replies a model gave, so the
 * result is the same on every run and spends no tokens. The page, the browser
 * and the step loop are real, with the default one retry.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { executeAction } from '../src/browser/actions.js';
import { executeStep } from '../src/runner/step-executor.js';
import { actionsOf } from '../src/codebehind/recording.js';
import { DEFAULT_BROWSER_DIMENSIONS } from '../src/config/browser-dimensions.js';
import type { ChatMessage } from '../src/ai/types.js';
import type { StepResult } from '../src/report/types.js';
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
});

afterEach(async () => {
  await page.close();
});

const signupUrl = (): string => `${server!.baseUrl}/signup.html`;

const reply = (actions: Record<string, unknown>[]): string =>
  JSON.stringify({ actions, reasoning: 'scripted' });
const typeInto = (selector: string, value: string): string =>
  reply([{ action: 'type', selector, value, description: `Type ${value}` }]);

const textOf = (m: ChatMessage): string =>
  typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');

/**
 * Run one step with the model's replies scripted, in order. Returns the step's
 * result and the text of every prompt the model was sent.
 */
async function runStep(
  index: number,
  total: number,
  instruction: string,
  replies: string[],
): Promise<{ result: StepResult; prompts: string[] }> {
  const queue = [...replies];
  const prompts: string[] = [];
  const complete = vi.fn(async (messages: ChatMessage[]) => {
    prompts.push(messages.map(textOf).join('\n'));
    const text = queue.shift();
    if (text === undefined) throw new Error(`the script for "${instruction}" has no reply left`);
    return { text, model: 'scripted' };
  });
  const result = await executeStep(index, total, instruction, {
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
    testName: 'Sign up',
    conversationHistory: [],
    csrfTokens: {},
  });
  return { result, prompts };
}

/** What a stray keystroke or Ctrl+A would have left behind. */
const pageState = (): Promise<Record<string, unknown>> =>
  page.evaluate(() => {
    const field = (name: string): string =>
      (document.querySelector(`[name="${name}"]`) as HTMLInputElement).value;
    const search = document.getElementById('site-search') as HTMLInputElement;
    return {
      email: field('email'),
      delivery: field('delivery'),
      search: search.value,
      searchFocused: document.activeElement === search,
      selected: String(window.getSelection()),
    };
  });

const untouched = { email: '', delivery: '', search: '', searchFocused: false, selected: '' };

const checkSays = (text: string): string[] => [
  reply([{ action: 'assert', condition: `the page says "${text}"`, expected: text, description: `Page says ${text}` }]),
  JSON.stringify({
    code: `(() => { const t = document.body.innerText; return { pass: t.includes(${JSON.stringify(text)}), actual: t.slice(0, 300) }; })()`,
  }),
];

describe('SecureBank Open an account: a type aimed at a field wrapper (steptix/steptix#34)', () => {
  it('the page: each wrapper carries the test id, and its middle is a hint that takes no focus', async () => {
    await page.goto(signupUrl());
    for (const testId of ['email-field', 'delivery-field']) {
      const middle = await page.evaluate((id) => {
        const wrapper = document.querySelector(`[data-testid="${id}"]`)!;
        wrapper.scrollIntoView({ block: 'center' });
        const r = wrapper.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement;
        return { tag: hit.tagName, className: hit.className, tabIndex: hit.tabIndex, holdsInput: wrapper.querySelector('input') !== null };
      }, testId);
      expect(middle, testId).toEqual({ tag: 'P', className: 'text-field__hint', tabIndex: -1, holdsInput: true });
    }
    // `s` outside a field jumps to search: what a keystroke typed into the
    // page would set off.
    await page.keyboard.press('s');
    expect(await pageState()).toEqual({ ...untouched, searchFocused: true });
  });

  it('the action fails, names where the focus went, and types nothing', async () => {
    await page.goto(signupUrl());
    const result = await executeAction(page, {
      action: 'type',
      selector: '[data-testid="email-field"]',
      value: 'ada@example.test',
      description: 'Type ada@example.test into the Email field',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Element is not an <input>, <textarea> or [contenteditable] element');
    expect(result.error).toContain('left the focus on <body>');
    expect(result.failedSelector).toBe('[data-testid="email-field"]');
    // No Ctrl+A selection, no search shortcut, nothing in any field.
    expect(await pageState()).toEqual(untouched);
  });

  it('the sign-up test: step 2 retries into the input, and the account is created', async () => {
    const total = 5;
    const step1 = await runStep(1, total, 'Navigate to /signup.html', [
      reply([{ action: 'navigate', url: signupUrl(), description: 'Open the sign-up page' }]),
    ]);
    expect(step1.result.status).toBe('passed');

    const step2 = await runStep(2, total, 'Type ada@example.test into the Email field', [
      typeInto('[data-testid="email-field"]', 'ada@example.test'),
      typeInto('[data-testid="email-field"] input', 'ada@example.test'),
    ]);
    expect(step2.result.status).toBe('passed');
    expect(step2.prompts).toHaveLength(2);
    // The retry tells the model why its first target was wrong.
    expect(step2.prompts[1]).toContain('left the focus on <body>');
    expect(await pageState()).toEqual({ ...untouched, email: 'ada@example.test' });
    // Compile learns from what happened: the failed type is not in the
    // recording, only the one that reached the field.
    expect(actionsOf(step2.result).map((a) => a.selector)).toEqual(['[data-testid="email-field"] input']);

    const step3 = await runStep(3, total, 'Type Secret123! into the Password field', [
      typeInto('#password', 'Secret123!'),
    ]);
    expect(step3.result.status).toBe('passed');

    const step4 = await runStep(4, total, 'Click Create account', [
      reply([{ action: 'click', selector: '#create-account', description: 'Click Create account' }]),
    ]);
    expect(step4.result.status).toBe('passed');

    const step5 = await runStep(5, total, 'Verify the page says "Check your inbox"', checkSays('Check your inbox'));
    expect(step5.result.status).toBe('passed');
    expect(await page.textContent('#confirmation-email')).toBe('We sent a link to ada@example.test.');
  });

  it('an optional field: the step retries, so the test cannot pass with nothing in it', async () => {
    const total = 5;
    await runStep(1, total, 'Navigate to /signup.html', [
      reply([{ action: 'navigate', url: signupUrl(), description: 'Open the sign-up page' }]),
    ]);
    await runStep(2, total, 'Type ada@example.test into the Email field', [
      typeInto('[data-testid="email-field"] input', 'ada@example.test'),
    ]);
    await runStep(3, total, 'Type Secret123! into the Password field', [typeInto('#password', 'Secret123!')]);

    const step = await runStep(4, total, 'Type "Leave it by the back door" into the Card delivery instructions field', [
      typeInto('[data-testid="delivery-field"]', 'Leave it by the back door'),
      typeInto('[data-testid="delivery-field"] input', 'Leave it by the back door'),
    ]);
    expect(step.result.status).toBe('passed');
    expect(step.prompts).toHaveLength(2);
    expect(step.prompts[1]).toContain('left the focus on <body>');

    await runStep(5, total, 'Click Create account', [
      reply([{ action: 'click', selector: '#create-account', description: 'Click Create account' }]),
    ]);
    expect(await page.textContent('#confirmation-delivery')).toBe('Card delivery: Leave it by the back door');
  });
});
