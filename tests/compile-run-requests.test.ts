import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page } from 'playwright';
import type { AiClient } from '../src/ai/client.js';
import type { AIAction } from '../src/ai/types.js';
import type { Config } from '../src/config/types.js';
import type { StepResult, SubActionResult } from '../src/report/types.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { buildStepCodePrompt } from '../src/ai/prompts.js';
import { actionsOf, type RecordedAction } from '../src/codebehind/recording.js';

/**
 * The same wait on AI steps during compile runs
 * (docs/specs/SPEC-codebehind-robustness.md §6.9): after an AI action that
 * changes the page, a compile run also waits for any first-party request still
 * in flight once the post-action settle is done — so the page after the step
 * shows what a slow request produced — and records the requests each action
 * started, for the generator to read as evidence. An ordinary run keeps
 * today's wait.
 */

const timeline = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('../src/browser/page-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/page-state.js')>();
  return {
    ...actual,
    armActionWatcher: () => {
      timeline.events.push('arm');
      return {
        ready: Promise.resolve(),
        settle: async (_signal?: AbortSignal, options?: { onlyIfPending?: boolean }) => {
          timeline.events.push(options?.onlyIfPending ? 'settle:if-pending' : 'settle');
          return {
            waitedMs: 0,
            tracked: 1,
            stillPending: [],
            requests: [{ method: 'POST', path: '/api/login', status: 200, ms: 1500 }],
          };
        },
        dispose: () => timeline.events.push('dispose'),
      };
    },
    waitForPageStability: async () => ({
      isLoading: false, loadingIndicators: [], hasErrorOverlay: false,
      errorMessages: [], hasModal: false, documentLoading: false,
    }),
    waitForPostActionSettle: async () => {
      timeline.events.push('post-action-settle');
    },
    capturePageSignal: async () => ({ url: 'http://localhost:8787/index.html', domFingerprint: 'fp' }),
    diagnosePageState: async () => ({
      isLoading: false, loadingIndicators: [], hasErrorOverlay: false,
      errorMessages: [], hasModal: false, documentLoading: false,
    }),
  };
});

vi.mock('../src/browser/screenshot.js', () => ({ captureScreenshot: async () => null }));

vi.mock('../src/browser/dom-cleaner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/dom-cleaner.js')>();
  return { ...actual, captureDomSnapshot: vi.fn(async () => '<html><body>dom</body></html>') };
});

vi.mock('../src/browser/actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser/actions.js')>();
  return {
    ...actual,
    executeAction: vi.fn(async (_page: unknown, action: AIAction) => {
      timeline.events.push(`action:${action.action}`);
      return { success: true };
    }),
  };
});

import { executeStep } from '../src/runner/step-executor.js';

beforeEach(() => {
  timeline.events = [];
});

function fakePage(): Page {
  return {
    on: () => {},
    off: () => {},
    url: () => 'http://localhost:8787/index.html',
    title: async () => 'SecureBank',
    context: () => ({ browser: () => ({}), on: () => {}, off: () => {} }),
    evaluate: async () => ({ pass: true }),
    screenshot: async () => Buffer.alloc(24),
    waitForLoadState: async () => {},
  } as unknown as Page;
}

const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
  browser: { ...DEFAULT_CONFIG.browser, captureScreenshotsPerAction: false, headed: false },
  execution: { ...DEFAULT_CONFIG.execution, retries: 0, maxTurns: 2, promptOnAmbiguity: false },
};

/** A model that answers with `actions` once and declares the step done. */
function model(actions: AIAction[]): AiClient {
  return {
    complete: async () => ({
      text: JSON.stringify({ actions, reasoning: 'do it', needs_reeval: false }),
      model: 'stub',
    }),
  } as unknown as AiClient;
}

async function runStep(actions: AIAction[], captureStepContext: boolean): Promise<StepResult> {
  return executeStep(1, 1, 'Click the Sign in button', {
    page: fakePage(),
    config: CONFIG,
    aiClient: model(actions),
    contextContent: '',
    testName: 'signin',
    conversationHistory: [],
    csrfTokens: {},
    resolvedParameters: {},
    ...(captureStepContext && { captureStepContext: true }),
  });
}

const subActionsOf = (result: StepResult): SubActionResult[] => result.turns.flatMap((t) => t.subActions);

describe('the executor (§6.9)', () => {
  const CLICK: AIAction = { action: 'click', selector: '#sign-in-btn', description: 'Click Sign in' };

  it('on a compile run, arms the watcher for an action that changes the page, after the post-action settle', async () => {
    const result = await runStep([CLICK], true);
    expect(result.status).toBe('passed');
    expect(timeline.events).toEqual(['arm', 'action:click', 'post-action-settle', 'settle:if-pending', 'dispose']);
    expect(subActionsOf(result)[0]!.requests).toEqual([{ method: 'POST', path: '/api/login', status: 200, ms: 1500 }]);
  });

  it('on an ordinary run, keeps today\'s wait and records no requests', async () => {
    const result = await runStep([CLICK], false);
    expect(result.status).toBe('passed');
    expect(timeline.events).toEqual(['action:click', 'post-action-settle']);
    expect(subActionsOf(result)[0]!.requests).toBeUndefined();
  });

  it('does not arm it for an action that only reads', async () => {
    const result = await runStep([{ action: 'read', selector: '#title', as: 'title', description: 'Read the title' }], true);
    expect(result.status).toBe('passed');
    expect(timeline.events).not.toContain('arm');
  });
});

// ── actionsOf and the prompt ─────────────────────────────────────────────────

function resultWith(...subActions: SubActionResult[]): StepResult {
  return {
    index: 1,
    instruction: 'Click the Sign in button',
    status: 'passed',
    turns: [{ turnNumber: 1, attemptNumber: 1, timestamp: '2026-10-08T00:00:00.000Z', aiInteractions: [], subActions }],
    durationMs: 4,
    retried: false,
  };
}

const LOGIN = { method: 'POST', path: '/api/login', status: 200, ms: 1500 };

describe('actionsOf merges the requests an action started', () => {
  it('onto the action, beside its measurement', () => {
    const [action] = actionsOf(
      resultWith({
        index: 1,
        action: { action: 'click', selector: '#sign-in-btn' },
        durationMs: 1,
        targeting: { matchCount: 1 },
        requests: [LOGIN],
      }),
    );
    expect(action).toEqual({ action: 'click', selector: '#sign-in-btn', targeting: { matchCount: 1 }, requests: [LOGIN] });
  });

  it('and leaves an empty list off', () => {
    const sa: SubActionResult = { index: 1, action: { action: 'click', selector: '#go' }, durationMs: 1, requests: [] };
    expect(actionsOf(resultWith(sa))[0]).toBe(sa.action);
  });
});

describe('the generation prompt', () => {
  const LEGEND = 'An action with `requests` started those requests to the page\'s own site on this run';
  const prompt = (actions: RecordedAction[]) =>
    buildStepCodePrompt({ rawStepText: 'Click the Sign in button', parameters: [], actions }).content as string;

  it('shows them as observed on this run, with one legend line', () => {
    const text = prompt([{ action: 'click', selector: '#sign-in-btn', requests: [LOGIN] }]);
    expect(text).toContain(LEGEND);
    expect(text).toContain('They were observed on this run: evidence of what the action does');
    expect(text).toContain('"path": "/api/login"');
  });

  it('says nothing of requests when no action has any', () => {
    expect(prompt([{ action: 'click', selector: '#sign-in-btn' }])).not.toContain(LEGEND);
  });
});
