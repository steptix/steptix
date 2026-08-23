import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { StepCache } from '../src/cache/step-cache.js';

/**
 * A cache hit captures step context when asked
 * (stories/codebehind-compile-as-a-run.md §Ordinary runs capture what a
 * compile needs).
 *
 * A replay from the action cache skips the turn-1 DOM snapshot — no AI call,
 * no consumer, and the biggest wall-clock win a cached step has. But the
 * snapshot is `domBefore`, the compile's generation input, and a cached step
 * is by definition an uncompiled one. So with `captureStepContext` on, the
 * snapshot is taken after all; without it, nothing changes.
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

/** A cache that always hits with a one-turn, no-op plan. */
function hittingCache(): StepCache {
  return {
    read: async () => [
      {
        rawResponse: '{"reasoning":"cached","actions":[{"action":"noop","description":"nothing"}]}',
        actions: [{ action: 'noop', description: 'nothing' }],
        reasoning: 'cached',
      },
    ],
    write: async () => {},
    invalidateStep: async () => {},
  } as unknown as StepCache;
}

const forbiddenClient = {
  complete: async () => { throw new Error('a cache hit must not call the AI'); },
} as unknown as AiClient;

beforeEach(() => {
  domCleaner.captures = 0;
});

async function runCachedStep(captureStepContext: boolean | undefined) {
  return executeStep(1, 1, 'Open the dashboard', {
    page: fakePage(),
    config: CONFIG,
    aiClient: forbiddenClient,
    contextContent: '',
    testName: 'dashboard',
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: {},
    stepCache: hittingCache(),
    cacheEnabled: true,
    cacheKey: 1,
    ...(captureStepContext !== undefined && { captureStepContext }),
  });
}

describe('a cache hit and step context', () => {
  it('takes the turn-1 snapshot — and the post-step one — when context is asked for', async () => {
    const result = await runCachedStep(true);
    expect(result.status).toBe('passed');
    expect(result.fromCache).toBe(true);
    // Two captures: `domBefore` at turn 1, `domAfter` at the end.
    expect(domCleaner.captures).toBe(2);
    expect(result.stepContext).toEqual({
      domBefore: '<dom snapshot 1>',
      urlBefore: 'https://app.test/dashboard',
      domAfter: '<dom snapshot 2>',
      urlAfter: 'https://app.test/dashboard',
    });
  });

  it('still skips every snapshot when context is not asked for', async () => {
    const result = await runCachedStep(undefined);
    expect(result.status).toBe('passed');
    expect(result.fromCache).toBe(true);
    expect(domCleaner.captures).toBe(0);
    expect(result.stepContext).toBeUndefined();
  });
});
