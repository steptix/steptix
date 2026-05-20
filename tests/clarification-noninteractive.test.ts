/**
 * Regression for issues/014 — under a non-interactive (server-driven) run,
 * an AI clarification `prompt` action must NOT block on stdin (which would
 * hang the run forever). Instead the step fails fast, carrying the AI's
 * question as the error so the client can surface it.
 *
 * Drives the real `executeStep` with the browser/DOM modules mocked and a
 * fake AiClient that returns a single `prompt` action on turn 1.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Config } from '../src/config/types.js';

// ── Browser-layer mocks (executeStep imports these) ──────────────────
vi.mock('../src/browser/page-state.js', () => ({
  PageActivityTracker: class {
    constructor(_p: unknown) {}
    isIdle() { return true; }
    dispose() {}
  },
  diagnosePageState: vi.fn(async () => ({ isLoading: false })),
  waitForPageStability: vi.fn(async () => {}),
  waitForPostActionSettle: vi.fn(async () => {}),
  capturePageSignal: vi.fn(async () => ({})),
}));

vi.mock('../src/browser/dom-cleaner.js', () => ({
  captureDomSnapshot: vi.fn(async () => '<html></html>'),
  findInDom: vi.fn(async () => []),
  expandDomSubtree: vi.fn(async () => ''),
  formatFindResults: vi.fn(() => ''),
  formatExpandResult: vi.fn(() => ''),
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: vi.fn(async () => null),
}));

import { executeStep } from '../src/runner/step-executor.js';

function makeConfig(): Config {
  return {
    ai: { gatewayUrl: 'https://ai.test', model: 't', maxInputTokens: 1000, streamResponses: false, sendScreenshots: false },
    browser: { headed: false, viewport: { width: 1280, height: 720 }, windowSize: { width: 1280, height: 720 }, slowMo: 0, browser: 'chromium', fullPageScreenshots: true },
    tests: { dir: './tests', contextDir: './context', pattern: '**/*.md' },
    execution: { timeout: 30000, retries: 1, screenshotOnFailure: true, promptOnAmbiguity: true, maxTurns: 5 },
    reports: { outputDir: './reports', includeScreenshots: false, includeDomSnapshots: false, includeAiReasoning: false, embedScreenshots: false },
    api: { specsDir: './specs', requestTimeout: 30000, redactSensitive: true },
    server: { host: '127.0.0.1', port: 0, apiKey: 'k' },
    cache: { enabled: false, dir: '.cache' },
    logging: { consoleLogLevel: 'silent', serverFileLogLevel: 'off' },
  };
}

const QUESTION = 'Which "Save" button did you mean — header or footer?';

function fakeAiClient() {
  const complete = vi.fn(async () => ({
    text: JSON.stringify({
      actions: [{ action: 'prompt', question: QUESTION, description: 'ambiguous target' }],
      reasoning: 'There are two Save buttons; I need to know which one.',
    }),
    model: 'mock-model',
  }));
  return { complete } as any;
}

const stubPage = { url: () => 'https://example.com' } as any;

describe('executeStep — clarification under nonInteractive (issues/014)', () => {
  it('fails the step fast with the question as the error instead of blocking on stdin', async () => {
    const aiClient = fakeAiClient();
    const result = await executeStep(1, 1, 'Click the Save button', {
      page: stubPage,
      config: makeConfig(),
      aiClient,
      contextContent: '',
      testName: 'clarify-test',
      conversationHistory: [],
      csrfTokens: {},
      nonInteractive: true,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('no interactive prompt');
    expect(result.error).toContain(QUESTION);
    // The AI was consulted exactly once — we did NOT loop or retry the
    // ambiguous turn (re-asking can't resolve it).
    expect(aiClient.complete).toHaveBeenCalledTimes(1);
  });
});
