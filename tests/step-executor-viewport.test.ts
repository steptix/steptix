/**
 * What the model is TOLD the page size is (stories/per-test-viewport.md §2/§4).
 *
 * `## Config: viewport: mobile` reached the browser and not the prompt: the
 * page rendered at 390×844 while every step's Test Information block said
 * `1440×900px (desktop view)`, because the block read the
 * `windowSize`/`viewport` pair directly and nothing writes the test's size back
 * into those. That matters beyond a cosmetic line — system-prompt rule 4 has
 * the model pick between a responsive page's duplicate mobile and desktop
 * elements using exactly this number, and a "scroll a page" step sizes itself
 * from the height.
 *
 * So these assert the composition, not the helper: the real `executeStep` and
 * `executeBranchedStep`, a stub client, and the string the model actually
 * received. A unit test of `effectiveViewport` (tests/viewport-config.test.ts)
 * cannot catch a call site that forgets to call it, which is the entire bug.
 *
 * Harness copied from tests/step-executor-placeholders.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { AIAction, ChatMessage } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { StepGroup } from '../src/runner/step-grouper.js';

const actions = vi.hoisted(() => ({ received: [] as AIAction[] }));

vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return {
    ...actual,
    executeAction: vi.fn(async (_page: unknown, action: AIAction) => {
      actions.received.push(action);
      return { success: true };
    }),
  };
});

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return { ...actual, captureDomSnapshot: vi.fn(async () => '<html><body>dom</body></html>') };
});

vi.mock('../src/browser/page-state.js', () => ({
  diagnosePageState: async () => ({
    isLoading: false,
    loadingIndicators: [],
    hasErrorOverlay: false,
    errorMessages: [],
    hasModal: false,
    documentLoading: false,
  }),
  waitForPageStability: async () => {},
  waitForPostActionSettle: async () => {},
  capturePageSignal: async () => ({ url: 'https://app.test/', domLength: 1 }),
  PageActivityTracker: class {
    isIdle(): boolean { return true; }
    dispose(): void {}
  },
}));

import { executeStep, executeBranchedStep, evaluateConditions } from '../src/runner/step-executor.js';

function fakePage(): Page {
  return {
    on: () => {},
    off: () => {},
    url: () => 'https://app.test/dashboard',
    context: () => ({ browser: () => ({}) }),
    evaluate: async (arg: unknown) => {
      if (typeof arg === 'string') return { pass: true, actual: 'ok' };
      throw new Error('no DOM in this test');
    },
    screenshot: async () => { throw new Error('no screenshot in this test'); },
    waitForLoadState: async () => {},
  } as unknown as Page;
}

/** The project defaults every case below starts from: the 1440×900 pair on
 *  both sizing keys, which is what made the wrong answer look plausible. */
function configWith(browser: Partial<Config['browser']>): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
    browser: { ...DEFAULT_CONFIG.browser, captureScreenshotsPerAction: false, ...browser },
    execution: { ...DEFAULT_CONFIG.execution, retries: 0, maxTurns: 3, promptOnAmbiguity: false },
  };
}

const MOBILE = { width: 390, height: 844 };

function scriptedClient(responses: string[]): AiClient & { requests: ChatMessage[][] } {
  const requests: ChatMessage[][] = [];
  let turn = 0;
  return {
    requests,
    complete: async (messages: ChatMessage[]) => {
      requests.push(messages);
      const text = responses[turn] ?? responses[responses.length - 1]!;
      turn++;
      return { text, model: 'stub' };
    },
  } as unknown as AiClient & { requests: ChatMessage[][] };
}

function plan(acts: AIAction[]): string {
  return JSON.stringify({ actions: acts, reasoning: 'because', needs_reeval: false });
}

const CLICK = plan([{ action: 'click', selector: '#go', description: 'Go' }]);

function allRequestText(client: { requests: ChatMessage[][] }): string {
  return client.requests
    .flat()
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
    )
    .join('\n');
}

async function runStep(config: Config) {
  const client = scriptedClient([CLICK]);
  await executeStep(1, 1, 'Open the menu', {
    page: fakePage(),
    config,
    aiClient: client,
    contextContent: '',
    testName: 'viewport',
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: {},
  });
  return allRequestText(client);
}

beforeEach(() => {
  actions.received = [];
});

describe('the Test Information block names the size the page really is', () => {
  it('headless: a test viewport, not the project default', async () => {
    const text = await runStep(configWith({ headed: false, fixedViewport: MOBILE }));
    expect(text).toContain('- Viewport: 390×844px (mobile view)');
    expect(text).not.toContain('1440×900');
  });

  it('headed: the PAGE, not the window it sits in', async () => {
    // The headed branch read `windowSize`, which `fixedViewport` never
    // touches — so this is the case TestBench users actually run.
    const text = await runStep(configWith({ headed: true, fixedViewport: MOBILE }));
    expect(text).toContain('- Viewport: 390×844px (mobile view)');
    expect(text).not.toContain('1440×900');
  });

  it('the device-mode label follows it — the half rule 4 reads', async () => {
    const text = await runStep(
      configWith({ headed: true, fixedViewport: { width: 768, height: 1024 } }),
    );
    expect(text).toContain('(tablet view)');
    expect(text).not.toContain('(desktop view)');
  });

  it('no test viewport: the old behaviour exactly, in both modes', async () => {
    const headless = await runStep(configWith({ headed: false }));
    expect(headless).toContain('- Viewport: 1440×900px (desktop view)');
    const headed = await runStep(configWith({ headed: true }));
    expect(headed).toContain('- Viewport: 1440×900px (desktop view)');
  });

  it('a branched step is told the same size as a plain one', async () => {
    // Its own `formatTestInfo` call, fifteen hundred lines away from the
    // first — which is how one of the two could come to be fixed alone.
    const group: StepGroup = {
      conditionalSteps: [{ index: 1, instruction: 'If a cookie banner shows, dismiss it' }],
      continuationStep: { index: 2, instruction: 'Open the menu' },
    };
    const client = scriptedClient([
      JSON.stringify({
        matched: 'A',
        actions: [{ action: 'click', selector: '#ok', description: 'OK' }],
        reasoning: 'showing',
      }),
      CLICK,
      CLICK,
    ]);
    await executeBranchedStep(group, 2, {
      page: fakePage(),
      config: configWith({ headed: true, fixedViewport: MOBILE }),
      aiClient: client,
      contextContent: '',
      testName: 'viewport-branched',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
    });
    expect(allRequestText(client)).toContain('- Viewport: 390×844px (mobile view)');
  });

  it('a condition guard is told the same size as a step', async () => {
    // The third `formatTestInfo` call: the judge behind `[if …]` guards, which
    // reads the same Test Information block to decide what is on screen.
    const client = scriptedClient([JSON.stringify({ matched: 'none', actions: [], reasoning: 'no' })]);
    await evaluateConditions(['the menu is open'], {
      page: fakePage(),
      config: configWith({ headed: true, fixedViewport: MOBILE }),
      aiClient: client,
      contextContent: '',
      testName: 'viewport-condition',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
    });
    const text = allRequestText(client);
    expect(text).toContain('- Viewport: 390×844px (mobile view)');
    expect(text).not.toContain('1440×900');
  });
});
