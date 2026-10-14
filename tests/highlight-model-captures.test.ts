/**
 * The captures whose picture a model reads ask for the `'model'` audience
 * (docs/specs/SPEC-interaction-highlight.md §4.2) — pinned here, because
 * `captureScreenshot` cannot tell on its own, and a site reverted to the
 * default `'report'` would send highlight rings to the model with every other
 * suite still green (review round 1, finding 3).
 *
 * `captureScreenshot` is mocked and records the audience it was asked for;
 * what it does with it is tests/highlight-paths.test.ts's business. The step
 * executor runs for real against a fake page, as in
 * tests/step-executor-placeholders.test.ts. `GET /sessions/:id` is pinned in
 * tests/session-lazy-launch.test.ts, which has the session mocks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright';
import type { AIAction, ChatMessage } from '../src/ai/types.js';
import type { AiClient } from '../src/ai/client.js';
import type { Config } from '../src/config/types.js';
import type { TestReport } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

const shots = vi.hoisted(() => ({
  audiences: [] as string[],
  /** Make every page action fail, to reach the failure screenshot. */
  failActions: false,
  answer: { base64: 'SHOT', width: 1, height: 1 } as { base64: string; width: number; height: number } | null,
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: vi.fn(async (_page: unknown, _full?: boolean, audience = 'report') => {
    shots.audiences.push(audience);
    return shots.answer;
  }),
}));

vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return {
    ...actual,
    executeAction: vi.fn(async () =>
      shots.failActions ? { success: false, error: 'no such element', retryable: false } : { success: true }),
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
  armActionWatcher: () => ({ ready: Promise.resolve(), settle: async () => ({}), dispose: () => {} }),
  PageActivityTracker: class {
    isIdle(): boolean { return true; }
    dispose(): void {}
  },
}));

import { executeStep, evaluateConditions } from '../src/runner/step-executor.js';
import { diagnoseFailure } from '../src/ai/diagnose.js';
import { createHighlighter, HIGHLIGHT_DEFAULTS, ringsOutOfScreenshots } from '../src/browser/highlight.js';

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
    waitForLoadState: async () => {},
  } as unknown as Page;
}

/** Report captures off, so every capture left is one a model reads. */
function config(sendScreenshots: boolean, perAction = false): Config {
  return {
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, sendScreenshots },
    browser: { ...DEFAULT_CONFIG.browser, captureScreenshotsPerAction: perAction, headed: false },
    execution: {
      ...DEFAULT_CONFIG.execution,
      retries: 0,
      maxTurns: 3,
      promptOnAmbiguity: false,
      screenshotOnFailure: false,
    },
  };
}

function scriptedClient(responses: string[]): AiClient {
  let turn = 0;
  return {
    complete: async (_messages: ChatMessage[]) => {
      const text = responses[turn] ?? responses[responses.length - 1]!;
      turn++;
      return { text, model: 'stub' };
    },
  } as unknown as AiClient;
}

const plan = (acts: Array<Partial<AIAction>>): string =>
  JSON.stringify({ actions: acts.map((a) => ({ description: 'scripted', ...a })), reasoning: 'scripted' });

async function run(instruction: string, responses: string[], cfg: Config): Promise<void> {
  await executeStep(1, 1, instruction, {
    page: fakePage(),
    config: cfg,
    aiClient: scriptedClient(responses),
    contextContent: '',
    testName: 'model captures',
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: {},
  });
}

beforeEach(() => {
  shots.audiences = [];
  shots.answer = { base64: 'SHOT', width: 1, height: 1 };
  shots.failActions = false;
});

describe('a run whose pictures go to a model takes its REPORT captures for the model too', () => {
  // A `screenshotsToModel` batch, an errand, a compile: `ringsOutOfScreenshots`
  // config, report captures on. Every capture the step takes must ask for
  // `'model'` (review round 2, item E).
  function modelRun(): Config {
    const base = config(false, true);
    return {
      ...base,
      browser: ringsOutOfScreenshots({ ...base.browser, highlight: true }),
      execution: { ...base.execution, screenshotOnFailure: true },
    };
  }

  it('pre-turn, after the action, and at the step end', async () => {
    await run('Click Go', [plan([{ action: 'click', selector: '#go' }])], modelRun());
    expect(shots.audiences.length).toBeGreaterThanOrEqual(3);
    expect(shots.audiences.every((a) => a === 'model')).toBe(true);
  });

  it('the failure screenshot', async () => {
    shots.failActions = true;
    await run('Click Go', [plan([{ action: 'click', selector: '#go' }])], modelRun());
    expect(shots.audiences.length).toBeGreaterThan(0);
    expect(shots.audiences.every((a) => a === 'model')).toBe(true);
  });

  it('a code-behind step\'s step-end capture', async () => {
    const page = fakePage();
    await executeStep(1, 1, 'Click Go', {
      page,
      config: modelRun(),
      aiClient: scriptedClient(['{}']),
      contextContent: '',
      testName: 'model captures',
      conversationHistory: [],
      csrfTokens: {},
      resolvedParameters: {},
      codeBehind: {
        file: '/virtual/x.steps.ts',
        source: 'Click Go',
        occurrence: 0,
        scope: { renames: {}, inputs: {} },
        entry: { source: 'Click Go', run: async () => {} },
      },
    });
    expect(shots.audiences).toEqual(['model']);
  });
});

describe('the step executor', () => {
  it('takes the pre-turn capture for the model when the model is sent screenshots', async () => {
    await run('Click Go', [plan([{ action: 'click', selector: '#go' }])], config(true));
    expect(shots.audiences.length).toBeGreaterThan(0);
    expect(shots.audiences.every((a) => a === 'model')).toBe(true);
  });

  it('and for the report when it is not — the control', async () => {
    await run('Click Go', [plan([{ action: 'click', selector: '#go' }])], config(false, true));
    expect(shots.audiences[0]).toBe('report');
  });

  it('takes the assertion-code capture for the model', async () => {
    await run(
      'Verify the page says Ada',
      [
        plan([{ action: 'assert', condition: 'the page says "Ada"', expected: 'Ada' }]),
        JSON.stringify({ code: '(() => ({ pass: true, actual: "Ada" }))()' }),
      ],
      config(true),
    );
    // The pre-turn capture and the assertion's own, and nothing for the report.
    expect(shots.audiences.length).toBeGreaterThanOrEqual(2);
    expect(shots.audiences.every((a) => a === 'model')).toBe(true);
  });

  it('takes the condition judge\'s capture for the model', async () => {
    await evaluateConditions(['the cart is empty'], {
      page: fakePage(),
      config: config(true),
      aiClient: scriptedClient(['{"matched":"A","actions":[],"reasoning":"empty"}']),
      contextContent: '',
      testName: 'judge',
      conversationHistory: [],
      csrfTokens: {},
    });
    expect(shots.audiences).toEqual(['model']);
  });
});

describe('failure diagnosis', () => {
  const report = (screenshotBase64?: string): TestReport => ({
    testName: 'diagnosed',
    filePath: '/x.md',
    tags: [],
    status: 'failed',
    steps: [{
      instruction: 'Click Go',
      status: 'failed',
      turns: [],
      durationMs: 1,
      retried: false,
      error: 'no Go',
      ...(screenshotBase64 !== undefined && { screenshotBase64 }),
    }],
    totalSteps: 1,
    passedSteps: 0,
    failedSteps: 1,
    totalSubActions: 0,
    durationMs: 1,
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    date: '',
  });

  /** The images the diagnosis request carried. */
  function imagesSent(): { client: AiClient; images: string[] } {
    const images: string[] = [];
    const client = {
      complete: async (messages: ChatMessage[]) => {
        for (const m of messages) {
          if (typeof m.content === 'string') continue;
          for (const b of m.content) if (b.type === 'image_url') images.push(b.image_url.url);
        }
        return { text: '{"rootCause":"x","faultCategory":"unknown","evidence":[],"suggestedFix":"x","confidence":"low"}', model: 'stub' };
      },
    } as unknown as AiClient;
    return { client, images };
  }

  it('takes its fresh capture for the model', async () => {
    const { client } = imagesSent();
    await diagnoseFailure(report(), fakePage(), client, '');
    expect(shots.audiences).toEqual(['model']);
  });

  it('falls back to the step\'s own picture only for a page no ring was drawn on', async () => {
    shots.answer = null; // the fresh capture fails
    const plain = imagesSent();
    await diagnoseFailure(report('STEPSHOT'), fakePage(), plain.client, '');
    expect(plain.images.some((url) => url.includes('STEPSHOT'))).toBe(true);

    // A page this process rang: the step's picture was taken for the report
    // and may hold a ring, so the model gets no image rather than that one.
    const ringed = fakePage();
    const locator = {
      page: () => ringed,
      evaluateAll: async () => 1,
      first: () => locator,
    };
    createHighlighter(HIGHLIGHT_DEFAULTS).mark(locator as never, 'act');
    const sent = imagesSent();
    await diagnoseFailure(report('STEPSHOT'), ringed, sent.client, '');
    expect(sent.images).toEqual([]);
  });
});

describe('[use computer] ends the browser\'s rings before its first screen capture (§6 item 1)', () => {
  it('calls endBrowserRings before the capture probe', async () => {
    const { enterComputerMode } = await import('../src/runner/computer-step.js');
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-computer-lock-'));
    const order: string[] = [];
    try {
      const entered = await enterComputerMode({
        lockId: 'highlight-test',
        desktop: { enabled: true, maxImageWidth: 1600, settleMs: 0, reportScreenshots: true },
        state: { surface: 'browser' },
        loadDesktopAdapter: async () => ({}) as never,
        probeCapture: async () => { order.push('probe'); },
        lock: { lockPath: path.join(dir, 'steptix-computer.lock') },
        endBrowserRings: async () => { order.push('end rings'); },
      });
      expect(entered.ok).toBe(true);
      expect(order).toEqual(['end rings', 'probe']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
