/**
 * A cached upload whose file is missing must not throw the cache away.
 *
 * stories/upload-action.md, decision 8: the cached plan is fine — the selector
 * it names is still right, the click after it is still right — and only the
 * file is absent. Invalidating would discard a good entry, and falling through
 * to AI would spend a turn on a failure no re-planning can fix.
 *
 * The composition is the point here: the same code path must STILL invalidate
 * and still fall through for an ordinary cached failure, which is what the
 * control case pins.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import type { Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { Config } from '../src/config/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { StepCache } from '../src/cache/step-cache.js';
import type { AIAction } from '../src/ai/types.js';

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return { ...actual, captureDomSnapshot: vi.fn(async () => '<dom>') };
});

import { executeStep } from '../src/runner/step-executor.js';

const repoRoot = path.resolve(__dirname, '..');
const uploadPaths = { baseDir: path.join(repoRoot, 'fixtures', 'tests'), projectRoot: repoRoot };

/** Enough page for the executor; every locator call rejects, which is what the
 *  ordinary-failure control needs. */
function fakePage(): Page {
  const deadLocator = {
    locator: () => deadLocator,
    and: () => deadLocator,
    first: () => deadLocator,
    count: async () => { throw new Error('no live DOM in this test'); },
    waitFor: async () => { throw new Error('no live DOM in this test'); },
    click: async () => { throw new Error('no live DOM in this test'); },
    setInputFiles: async () => { throw new Error('no live DOM in this test'); },
    evaluate: async () => { throw new Error('no live DOM in this test'); },
  };
  return {
    on: () => {},
    off: () => {},
    url: () => 'https://app.test/documents',
    context: () => ({ browser: () => ({}) }),
    locator: () => deadLocator,
    evaluate: async () => { throw new Error('no live DOM in this test'); },
    screenshot: async () => { throw new Error('no screenshot in this test'); },
    waitForLoadState: async () => {},
  } as unknown as Page;
}

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
  browser: { ...DEFAULT_CONFIG.browser, captureScreenshotsPerAction: false, headed: false },
  execution: {
    ...DEFAULT_CONFIG.execution,
    retries: 0,
    maxTurns: 2,
    promptOnAmbiguity: false,
    screenshotOnFailure: false,
  },
};

interface Spies {
  invalidated: number;
  aiCalls: number;
}

function harness(cachedAction: AIAction): { cache: StepCache; client: AiClient; spies: Spies } {
  const spies: Spies = { invalidated: 0, aiCalls: 0 };
  const cache = {
    read: async () => [
      {
        rawResponse: JSON.stringify({ reasoning: 'cached', actions: [cachedAction] }),
        actions: [cachedAction],
        reasoning: 'cached',
      },
    ],
    write: async () => {},
    invalidateStep: async () => { spies.invalidated++; },
  } as unknown as StepCache;

  const client = {
    complete: async () => {
      spies.aiCalls++;
      throw new Error('the AI was asked');
    },
  } as unknown as AiClient;

  return { cache, client, spies };
}

async function runCached(cachedAction: AIAction) {
  const { cache, client, spies } = harness(cachedAction);
  const result = await executeStep(1, 1, 'Upload the statement', {
    page: fakePage(),
    config: CONFIG,
    aiClient: client,
    contextContent: '',
    testName: 'documents',
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: {},
    stepCache: cache,
    cacheEnabled: true,
    cacheKey: 1,
    uploadPaths,
  });
  return { result, spies };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a cached upload whose file is missing', () => {
  it('fails the step, keeps the cache entry, and asks no AI', async () => {
    const { result, spies } = await runCached({
      action: 'upload',
      selector: '#statement-file',
      filePath: 'attachments/nope.png',
      description: 'Upload the statement',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Upload file not found');
    expect(spies.invalidated).toBe(0);
    expect(spies.aiCalls).toBe(0);
    // It never claims a retry it did not spend.
    expect(result.retried).toBe(false);
  });

  it('replays normally when the file IS there', async () => {
    // Same path through the executor, one directory entry apart — so the test
    // above is about the file, not about uploads being broken in this harness.
    const { result } = await runCached({
      action: 'upload',
      selector: '#statement-file',
      filePath: 'attachments/logo.png',
      description: 'Upload the statement',
    });

    // The fake page has no real DOM, so the action still fails — but on the
    // SELECTOR, after the path resolved, and that failure is retryable.
    expect(result.error).not.toContain('Upload file not found');
  });
});

describe('the control: an ordinary cached failure', () => {
  it('still invalidates the entry and still falls through to AI', async () => {
    const { result, spies } = await runCached({
      action: 'click',
      selector: '#nope',
      description: 'Click something that is not there',
    });

    expect(result.status).toBe('failed');
    expect(spies.invalidated).toBe(1);
    expect(spies.aiCalls).toBe(1);
    expect(result.error).toContain('the AI was asked');
  });
});
