import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

/**
 * An AI step captures step context when asked
 * (stories/codebehind-compile-as-a-run.md §Ordinary runs capture what a
 * compile needs).
 *
 * `stepContext` is the compile's generation input: the DOM and URL either
 * side of the step. `domBefore` is the turn-1 snapshot the model was shown;
 * `domAfter` is one extra capture taken only because the caller asked. Without
 * `captureStepContext` the result carries no context and the extra capture is
 * not paid for.
 */

const domCleaner = vi.hoisted(() => ({ captures: 0 }));

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return {
    ...actual,
    captureDomSnapshot: vi.fn(async () => {
      domCleaner.captures++;
      return `<dom snapshot ${domCleaner.captures}>`;
    }),
  };
});

import { executeStep } from '../src/runner/step-executor.js';

function fakePage(): Page {
  return {
    on: () => {},
    off: () => {},
    url: () => 'https://app.test/dashboard',
    context: () => ({ browser: () => ({}) }),
    evaluate: async () => { throw new Error('no DOM in this test'); },
    screenshot: async () => { throw new Error('no screenshot in this test'); },
    waitForLoadState: async () => {},
  } as unknown as Page;
}

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
  browser: { ...DEFAULT_CONFIG.browser, captureScreenshotsPerAction: false, headed: false },
  execution: { ...DEFAULT_CONFIG.execution, retries: 0, maxTurns: 2, promptOnAmbiguity: false },
};

/** A model that answers every turn with the same one-turn, no-op plan. */
function noopClient(): AiClient {
  return {
    complete: async () => ({
      text: '{"reasoning":"nothing to do","actions":[{"action":"noop","description":"nothing"}]}',
      model: 'stub',
    }),
  } as unknown as AiClient;
}

beforeEach(() => {
  domCleaner.captures = 0;
});

async function runStep(captureStepContext: boolean | undefined) {
  return executeStep(1, 1, 'Open the dashboard', {
    page: fakePage(),
    config: CONFIG,
    aiClient: noopClient(),
    contextContent: '',
    testName: 'dashboard',
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: {},
    ...(captureStepContext !== undefined && { captureStepContext }),
  });
}

describe('an AI step and step context', () => {
  it('records the turn-1 snapshot and a post-step one when context is asked for', async () => {
    const result = await runStep(true);
    expect(result.status).toBe('passed');
    // `domBefore` is the first capture — the one the model saw on turn 1 —
    // and `domAfter` the last, taken after the step's own post-action one.
    expect(result.stepContext).toEqual({
      domBefore: '<dom snapshot 1>',
      urlBefore: 'https://app.test/dashboard',
      domAfter: `<dom snapshot ${domCleaner.captures}>`,
      urlAfter: 'https://app.test/dashboard',
    });
    expect(domCleaner.captures).toBeGreaterThan(1);
  });

  it('carries no context, and pays for exactly one capture less, when it is not asked for', async () => {
    await runStep(true);
    const withContext = domCleaner.captures;
    domCleaner.captures = 0;

    const result = await runStep(undefined);
    expect(result.status).toBe('passed');
    expect(result.stepContext).toBeUndefined();
    expect(domCleaner.captures).toBe(withContext - 1);
  });
});
