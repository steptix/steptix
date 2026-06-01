import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/types.js';
import type { StepResult } from '../src/report/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPage = {
  url: vi.fn(() => 'https://example.com'),
  title: vi.fn(async () => 'Example'),
  goto: vi.fn(async () => null),
};

const mockPageTracker = {
  getActive: vi.fn(() => mockPage as any),
};

const mockBrowserSession = {
  browser: { isConnected: vi.fn(() => true) },
  context: {},
  page: mockPage,
  pageTracker: mockPageTracker,
};

// Track BrowserTracker instances created by the production code so tests can
// assert against their methods (e.g. closeAll on closeSession).
const browserTrackerInstances: Array<{ getActive: ReturnType<typeof vi.fn>; closeAll: ReturnType<typeof vi.fn> }> = [];

// Track AiClient instances so tests can assert the per-batch env re-sync
// (issue 019) — how many clients were built and what syncAuth was called with.
const aiClientInstances: Array<{ config: any; syncAuth: ReturnType<typeof vi.fn> }> = [];

vi.mock('../src/browser/manager.js', () => {
  class BrowserTracker {
    getActive: ReturnType<typeof vi.fn>;
    closeAll: ReturnType<typeof vi.fn>;
    constructor(initialSession: typeof mockBrowserSession) {
      this.getActive = vi.fn(() => initialSession);
      this.closeAll = vi.fn(async () => {});
      browserTrackerInstances.push(this);
    }
  }
  return {
    launchBrowser: vi.fn(async () => ({ ...mockBrowserSession })),
    PageTracker: vi.fn(),
    BrowserTracker,
  };
});

vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: vi.fn(async (): Promise<StepResult> => ({
    index: 1,
    instruction: 'mock step',
    status: 'passed',
    turns: [{ turnNumber: 1, attemptNumber: 1, timestamp: new Date().toISOString(), aiInteractions: [], subActions: [{ index: 1, action: { action: 'click', description: 'click button' }, durationMs: 10 }] }],
    durationMs: 100,
    retried: false,
    aiExplanation: 'Did the thing',
  })),
  // Default: the continuation branch passes. Overridden per-test for the abort case.
  executeBranchedStep: vi.fn(async (group: any): Promise<StepResult[]> => [{
    index: group.continuationStep.index,
    instruction: group.continuationStep.instruction,
    status: 'passed',
    turns: [],
    durationMs: 10,
    retried: false,
    aiExplanation: 'branch passed',
  }]),
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

vi.mock('../src/ai/client.js', () => ({
  // Mirrors the real AiClient's syncAuth contract closely enough to assert the
  // session-manager call site: it mutates `config` in place and records calls.
  // The real implementation is unit-tested against fetch in ai-client.test.ts.
  AiClient: class {
    config: any;
    chat = vi.fn(async () => '{}');
    syncAuth = vi.fn((model: string, apiKey: string | undefined) => {
      const changed = model !== this.config.model || apiKey !== this.config.apiKey;
      this.config = { ...this.config, model, apiKey };
      return changed ? `AI model → ${model}` : null;
    });
    constructor(config: any) {
      this.config = config;
      aiClientInstances.push(this);
    }
  },
}));

vi.mock('../src/utils/tokens.js', () => ({
  TokenTracker: class {
    resetStep = vi.fn();
    markRunStart = vi.fn();
    get total() { return 0; }
    get inputTotal() { return 0; }
    get outputTotal() { return 0; }
    get runTotal() { return 0; }
    get runInputTotal() { return 0; }
    get runOutputTotal() { return 0; }
  },
}));

vi.mock('../src/api/response-store.js', () => ({
  ApiResponseStore: class {
    store = vi.fn();
    getHistory = vi.fn(() => []);
  },
}));

vi.mock('../src/report/generator.js', () => ({
  generateReport: vi.fn(async () => '/tmp/fake-report.html'),
  getPrimaryModel: vi.fn(() => 'mock-model'),
}));

vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: vi.fn(async () => ({ base64: 'fakeScreenshotBase64' })),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  addLogCallback: vi.fn(() => () => {}),
  addTraceCallback: vi.fn(() => () => {}),
  isVerbose: vi.fn(() => false),
  shouldEmit: vi.fn(() => true),
  setLogLevel: vi.fn(),
  getLogLevel: vi.fn(() => 'info'),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { SessionManager } from '../src/server/session-manager.js';
import { executeStep, executeBranchedStep } from '../src/runner/step-executor.js';
import { sanitizeTestName, computeStepsHash } from '../src/cache/step-cache.js';

// ---------------------------------------------------------------------------
// Config fixture
// ---------------------------------------------------------------------------

const testConfig: Config = {
  ai: {
    gatewayUrl: 'https://ai.test',
    model: 'test-model',
    maxInputTokens: 1000,
    streamResponses: false,
    sendScreenshots: false,
  },
  browser: {
    headed: false,
    viewport: { width: 1280, height: 720 },
    windowSize: { width: 1280, height: 720 },
    slowMo: 0,
    browser: 'chromium',
    fullPageScreenshots: true,
  },
  tests: {
    dir: './tests',
    contextDir: './context',
    pattern: '**/*.md',
  },
  execution: {
    timeout: 30_000,
    retries: 1,
    screenshotOnFailure: true,
    promptOnAmbiguity: false,
    maxTurns: 5,
  },
  reports: {
    outputDir: './reports',
    includeScreenshots: true,
    includeDomSnapshots: true,
    includeAiReasoning: true,
    embedScreenshots: true,
  },
  api: {
    specsDir: './specs',
    requestTimeout: 30_000,
    redactSensitive: true,
  },
  server: {
    host: '127.0.0.1',
    port: 3100,
    apiKey: 'test-api-key',
  },
  cache: {
    enabled: false,
    dir: '.cache',
  },
  logging: {
    consoleLogLevel: 'silent',
    serverFileLogLevel: 'off',
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    browserTrackerInstances.length = 0;
    aiClientInstances.length = 0;
    // Reset executeStep to the default "passed" implementation. `clearAllMocks`
    // only clears call history, not implementations — without this, a test that
    // sets a custom `mockImplementation` (e.g. the mid-step abort test) leaks it
    // into later tests that rely on the default. Restoring here makes the suite
    // order-independent.
    vi.mocked(executeStep).mockImplementation(async (): Promise<StepResult> => ({
      index: 1,
      instruction: 'mock step',
      status: 'passed',
      turns: [{ turnNumber: 1, attemptNumber: 1, timestamp: new Date().toISOString(), aiInteractions: [], subActions: [{ index: 1, action: { action: 'click', description: 'click button' }, durationMs: 10 }] }],
      durationMs: 100,
      retried: false,
      aiExplanation: 'Did the thing',
    }));
    vi.mocked(executeBranchedStep).mockImplementation(async (group: any): Promise<StepResult[]> => [{
      index: group.continuationStep.index,
      instruction: group.continuationStep.instruction,
      status: 'passed',
      turns: [],
      durationMs: 10,
      retried: false,
      aiExplanation: 'branch passed',
    }]);
    manager = new SessionManager(testConfig);
  });

  describe('re-applies .env AI overrides per batch on a reused session (issue 019)', () => {
    it('picks up a changed AI_MODEL/AI_API_KEY on the next run and reverts removed keys to the server base', async () => {
      const sessionId = 'reuse-1';

      // Three runs on the SAME session — the reuse path that froze the model
      // before this fix. Each ships the .env-derived env map.
      await manager.executeSteps(sessionId, { steps: ['s1'], env: { AI_MODEL: 'model-A', AI_API_KEY: 'key-1' } });
      await manager.executeSteps(sessionId, { steps: ['s2'], env: { AI_MODEL: 'model-B' } });
      await manager.executeSteps(sessionId, { steps: ['s3'] });

      // Session reused → exactly one AiClient built (not rebuilt per batch, so
      // browser state is preserved).
      expect(aiClientInstances).toHaveLength(1);
      const ai = aiClientInstances[0]!;

      // syncAuth runs at the top of every batch, recomputed from the server
      // base (testConfig.ai: model 'test-model', no apiKey) — so a key omitted
      // from a later .env reverts to base rather than sticking on the prior
      // override.
      expect(ai.syncAuth.mock.calls).toEqual([
        ['model-A', 'key-1'],       // batch 1: both from env
        ['model-B', undefined],     // batch 2: model from env; key reverts to base (omitted)
        ['test-model', undefined],  // batch 3: empty env → all revert to base
      ]);
      // And the live client reflects the final state.
      expect(ai.config.model).toBe('test-model');
      expect(ai.config.apiKey).toBeUndefined();
    });
  });

  describe('executeSteps', () => {
    it('creates a new session on first executeSteps call', async () => {
      const response = await manager.executeSteps('session-1', {
        steps: ['Click the button'],
      });

      expect(response.sessionId).toBe('session-1');
      expect(response.status).toBe('passed');
      expect(response.stepsCompleted).toBe(1);
      expect(response.stepsTotal).toBe(1);
    });

    it('returns proper StepResponse structure', async () => {
      const response = await manager.executeSteps('session-1', {
        steps: ['Click the button'],
      });

      expect(response).toHaveProperty('sessionId');
      expect(response).toHaveProperty('status');
      expect(response).toHaveProperty('stepsCompleted');
      expect(response).toHaveProperty('stepsTotal');
      expect(response).toHaveProperty('results');
      expect(response).toHaveProperty('outputs');
      expect(response).toHaveProperty('error');
      expect(response.error).toBeNull();
      expect(Array.isArray(response.results)).toBe(true);
      expect(response.results).toHaveLength(1);
      expect(response.results[0]).toHaveProperty('step');
      expect(response.results[0]).toHaveProperty('status');
      expect(response.results[0]).toHaveProperty('actions');
      expect(response.results[0]).toHaveProperty('screenshot');
      expect(response.results[0]).toHaveProperty('reasoning');
      expect(response.results[0]).toHaveProperty('outputs');
    });

    it('accumulates outputs across multiple executeSteps calls', async () => {
      // First call stores a value via output prefix
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, instruction, opts) => {
        // Simulate the step executor storing a captured value
        if (opts.resolvedParameters) {
          opts.resolvedParameters['orderNumber'] = 'ORD-123';
        }
        return {
          index: 1,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: 50,
          retried: false,
        };
      });

      await manager.executeSteps('session-1', {
        steps: ['[output: orderNumber] Get the order number'],
      });

      // Second call — the session should still have the output
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, instruction, opts) => {
        // The resolvedParameters should contain the previously captured output
        if (opts.resolvedParameters) {
          opts.resolvedParameters['confirmCode'] = 'CONF-456';
        }
        return {
          index: 1,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: 50,
          retried: false,
        };
      });

      const response2 = await manager.executeSteps('session-1', {
        steps: ['[output: confirmCode] Get the confirmation code'],
      });

      expect(response2.outputs).toHaveProperty('orderNumber', 'ORD-123');
      expect(response2.outputs).toHaveProperty('confirmCode', 'CONF-456');
    });

    // ── Re-run a skill step with its variables (startAt + seedScope) ─────────
    it('a partial re-run (startAt) runs only the tail and seeds the scope', async () => {
      const ran: string[] = [];
      const scopeSeen: Array<Record<string, string>> = [];
      vi.mocked(executeStep).mockImplementation(async (_idx, _total, instruction, opts: any) => {
        ran.push(instruction);
        scopeSeen.push({ ...(opts.resolvedParameters ?? {}) });
        return { index: 1, instruction, status: 'passed', turns: [], durationMs: 1, retried: false };
      });

      const response = await manager.executeSteps('session-rerun', {
        steps: ['Step one', 'Step two', 'Step three'],
        sourceLines: [10, 11, 12],
        testFilePath: '/proj/test.md',
        startAt: { uri: '/proj/test.md', line: 11 },
        seedScope: { foo: 'bar', __skill1_internal: 'secret' },
      });

      expect(response.status).toBe('passed');
      // Step one (line 10) is skipped; the tail (lines 11, 12) runs.
      expect(ran).toEqual(['Step two', 'Step three']);
      // The seed reaches the run; the __skill* internal is stripped.
      expect(scopeSeen[0]).toHaveProperty('foo', 'bar');
      expect(scopeSeen[0]).not.toHaveProperty('__skill1_internal');
    });

    it('endAt bounds the slice — runs only the selected range, not to the end', async () => {
      const ran: string[] = [];
      vi.mocked(executeStep).mockImplementation(async (_idx, _total, instruction) => {
        ran.push(instruction);
        return { index: 1, instruction, status: 'passed', turns: [], durationMs: 1, retried: false };
      });

      const response = await manager.executeSteps('session-endat', {
        steps: ['Step one', 'Step two', 'Step three', 'Step four'],
        sourceLines: [10, 11, 12, 13],
        testFilePath: '/proj/test.md',
        startAt: { uri: '/proj/test.md', line: 11 },
        endAt: { uri: '/proj/test.md', line: 12 },
      });

      expect(response.status).toBe('passed');
      // Step one (line 10) is before the start; Step four (line 13) is after the
      // end — both skipped. Only the selected 11–12 range runs.
      expect(ran).toEqual(['Step two', 'Step three']);
    });

    it('absent endAt runs from startAt to the end (startAt-only regression)', async () => {
      const ran: string[] = [];
      vi.mocked(executeStep).mockImplementation(async (_idx, _total, instruction) => {
        ran.push(instruction);
        return { index: 1, instruction, status: 'passed', turns: [], durationMs: 1, retried: false };
      });

      const response = await manager.executeSteps('session-endat-none', {
        steps: ['Step one', 'Step two', 'Step three', 'Step four'],
        sourceLines: [10, 11, 12, 13],
        testFilePath: '/proj/test.md',
        startAt: { uri: '/proj/test.md', line: 11 },
      });

      expect(response.status).toBe('passed');
      // No endAt → run to the end of the expansion (the merged startAt behaviour).
      expect(ran).toEqual(['Step two', 'Step three', 'Step four']);
    });

    it('refuses a partial re-run whose tail needs an unseedable internal var', async () => {
      const response = await manager.executeSteps('session-refuse', {
        steps: ['Type {{__skill1_token}} into the box'],
        sourceLines: [10],
        testFilePath: '/proj/test.md',
        startAt: { uri: '/proj/test.md', line: 10 },
        seedScope: {},
      });

      expect(response.status).toBe('error');
      expect(response.error?.message ?? '').toMatch(/re-run the whole skill/i);
      // The step must NOT have been executed with a literal placeholder.
      expect(vi.mocked(executeStep)).not.toHaveBeenCalled();
    });

    it('parameters from request override accumulated outputs', async () => {
      // First call: output gets stored
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, instruction, opts) => {
        if (opts.resolvedParameters) {
          opts.resolvedParameters['myVar'] = 'from-output';
        }
        return {
          index: 1,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: 50,
          retried: false,
        };
      });

      await manager.executeSteps('session-1', {
        steps: ['[output: myVar] Capture a value'],
      });

      // Second call: provide the same variable as a request parameter
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, instruction, opts) => {
        // resolvedParameters should have the overridden value
        expect(opts.resolvedParameters!['myVar']).toBe('override-value');
        return {
          index: 1,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: 50,
          retried: false,
        };
      });

      await manager.executeSteps('session-1', {
        steps: ['Use the variable'],
        parameters: { myVar: 'override-value' },
      });
    });

    it('errors when config is sent on non-first request', async () => {
      await manager.executeSteps('session-1', {
        steps: ['Step 1'],
        config: { baseUrl: 'https://example.com' },
      });

      await expect(
        manager.executeSteps('session-1', {
          steps: ['Step 2'],
          config: { baseUrl: 'https://other.com' },
        }),
      ).rejects.toThrow('Config can only be provided on the first request');
    });

    it('stops on first failure', async () => {
      let callCount = 0;
      vi.mocked(executeStep).mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          return {
            index: 2,
            instruction: 'step 2',
            status: 'failed',
            turns: [],
            durationMs: 50,
            retried: false,
            error: 'Element not found',
          };
        }
        return {
          index: callCount,
          instruction: `step ${callCount}`,
          status: 'passed',
          turns: [],
          durationMs: 50,
          retried: false,
        };
      });

      const response = await manager.executeSteps('session-1', {
        steps: ['Step 1', 'Step 2', 'Step 3'],
      });

      expect(response.status).toBe('failed');
      expect(response.stepsCompleted).toBe(1);
      expect(response.stepsTotal).toBe(3);
      expect(response.results).toHaveLength(2); // step 1 passed, step 2 failed, step 3 never ran
      expect(response.error).toEqual({ step: 1, message: 'Element not found' });
    });

    it('aborts between steps when the AbortSignal is triggered', async () => {
      let callCount = 0;
      vi.mocked(executeStep).mockImplementation(async () => {
        callCount++;
        return {
          index: callCount,
          instruction: `step ${callCount}`,
          status: 'passed',
          turns: [],
          durationMs: 10,
          retried: false,
        };
      });

      const ac = new AbortController();
      // Abort after the first step completes — the loop should stop before
      // running step 2.
      const onEvent = (event: { type: string; line?: number; status?: string }) => {
        if (event.type === 'step:pass' && callCount === 1) ac.abort();
      };

      const response = await manager.executeSteps(
        'session-1',
        { steps: ['Step 1', 'Step 2', 'Step 3'] },
        onEvent,
        ac.signal,
      );

      expect(callCount).toBe(1);
      expect(response.status).toBe('aborted');
      expect(response.stepsCompleted).toBe(1);
      expect(response.stepsTotal).toBe(3);
    });

    it('does not start any step if the signal is already aborted', async () => {
      vi.mocked(executeStep).mockClear();
      const ac = new AbortController();
      ac.abort();

      const response = await manager.executeSteps(
        'session-1',
        { steps: ['Step 1', 'Step 2'] },
        undefined,
        ac.signal,
      );

      expect(executeStep).not.toHaveBeenCalled();
      expect(response.status).toBe('aborted');
      expect(response.stepsCompleted).toBe(0);
    });

    it('emits a done event with status=aborted when interrupted', async () => {
      const events: { type: string; status?: string }[] = [];
      const onEvent = (event: { type: string; status?: string }) => {
        events.push(event);
        if (event.type === 'step:pass') ac.abort();
      };
      const ac = new AbortController();

      await manager.executeSteps(
        'session-1',
        { steps: ['Step 1', 'Step 2'] },
        onEvent,
        ac.signal,
      );

      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent).toBeDefined();
      expect(doneEvent?.status).toBe('aborted');
    });

    it('threads the abort signal into executeStep', async () => {
      let received: unknown;
      vi.mocked(executeStep).mockImplementation(async (_l, _t, _i, opts: any) => {
        received = opts.signal;
        return { index: 1, instruction: 's1', status: 'passed', turns: [], durationMs: 5, retried: false };
      });
      const ac = new AbortController();
      await manager.executeSteps('session-1', { steps: ['Step 1'] }, undefined, ac.signal);
      expect(received).toBe(ac.signal);
    });

    it('reports aborted (not failed) and emits no step:fail when stopped mid-step', async () => {
      // The real executeStep swallows a cancelled AI call's AbortError and
      // returns a 'failed' StepResult. The run loop must convert that to
      // 'aborted' — this is the bug the first plan draft would have shipped
      // (it would have reported 'failed'). See issues/020.
      const ac = new AbortController();
      let calls = 0;
      let sawSignal = false;
      vi.mocked(executeStep).mockImplementation(async (_l, _t, _i, opts: any) => {
        calls++;
        sawSignal = opts.signal instanceof AbortSignal;
        ac.abort(); // client stops while the step is in flight
        // Mirror executeStep's swallowed-abort return shape.
        return {
          index: calls,
          instruction: `step ${calls}`,
          status: 'failed',
          turns: [],
          durationMs: 5,
          retried: true,
          error: 'Aborted by client',
        };
      });

      const events: { type: string; status?: string }[] = [];
      const response = await manager.executeSteps(
        'session-1',
        { steps: ['Step 1', 'Step 2', 'Step 3'] },
        (e) => events.push(e as any),
        ac.signal,
      );

      expect(sawSignal).toBe(true);                  // signal reached executeStep
      expect(calls).toBe(1);                          // no further steps after stop
      expect(response.status).toBe('aborted');        // NOT 'failed'
      expect(events.some((e) => e.type === 'step:fail')).toBe(false);
      const done = events.find((e) => e.type === 'done');
      expect(done?.status).toBe('aborted');
    });

    it('reports aborted (not failed) when stopped inside a conditional/branched step (BUG-1)', async () => {
      // A conditional group ("If ..." + continuation). When the abort lands
      // inside the matched branch's inner executeStep, executeBranchedStep
      // returns a swallowed-abort 'failed' result rather than throwing — the
      // run loop must still report 'aborted'. See issues/020.
      const ac = new AbortController();
      let sawSignal = false;
      vi.mocked(executeBranchedStep).mockImplementation(async (group: any, _t: any, opts: any): Promise<StepResult[]> => {
        sawSignal = opts.signal instanceof AbortSignal;
        ac.abort(); // stop during the matched branch
        return [{
          index: group.continuationStep.index,
          instruction: group.continuationStep.instruction,
          status: 'failed',
          turns: [],
          durationMs: 5,
          retried: true,
          error: 'Aborted by client',
        }];
      });

      const events: { type: string; status?: string }[] = [];
      const response = await manager.executeSteps(
        'session-branch-abort',
        { steps: ['If a cookie banner appears, dismiss it', 'Wait for the dashboard'] },
        (e) => events.push(e as any),
        ac.signal,
      );

      expect(sawSignal).toBe(true);                  // signal reached executeBranchedStep
      expect(response.status).toBe('aborted');        // NOT 'failed'
      expect(events.some((e) => e.type === 'step:fail')).toBe(false);
      const done = events.find((e) => e.type === 'done');
      expect(done?.status).toBe('aborted');
    });

    it('skips [input:] steps', async () => {
      const response = await manager.executeSteps('session-1', {
        steps: ['[input: username] Enter your username'],
      });

      expect(response.status).toBe('passed');
      expect(response.results).toHaveLength(1);
      expect(response.results[0]!.reasoning).toContain('Skipped');
      expect(executeStep).not.toHaveBeenCalled();
    });

    it('skips [interactive] steps', async () => {
      const response = await manager.executeSteps('session-1', {
        steps: ['[interactive] Do some manual testing'],
      });

      expect(response.status).toBe('passed');
      expect(response.results).toHaveLength(1);
      expect(response.results[0]!.reasoning).toContain('Skipped');
      expect(executeStep).not.toHaveBeenCalled();
    });

    it('emits a capture event for each [output:] variable extracted', async () => {
      vi.mocked(executeStep).mockClear();
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, _instruction, opts) => {
        if (opts.resolvedParameters) {
          opts.resolvedParameters['orderId'] = 'ORD-789';
        }
        return {
          index: 1,
          instruction: 'mocked',
          status: 'passed',
          turns: [],
          durationMs: 50,
          retried: false,
        };
      });

      const events: { type: string; line?: number; name?: string; value?: string }[] = [];
      await manager.executeSteps(
        'session-1',
        { steps: ['[output: orderId] Get the order ID'] },
        (event) => events.push(event as any),
      );

      const captures = events.filter((e) => e.type === 'capture');
      expect(captures).toHaveLength(1);
      expect(captures[0]).toEqual({
        type: 'capture',
        line: 1,
        name: 'orderId',
        value: 'ORD-789',
        source: 'capture',
      });
    });

    it('emits multiple capture events when a step extracts multiple vars', async () => {
      vi.mocked(executeStep).mockClear();
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, _instruction, opts) => {
        if (opts.resolvedParameters) {
          opts.resolvedParameters['firstName'] = 'Alice';
          opts.resolvedParameters['lastName'] = 'Smith';
        }
        return {
          index: 1,
          instruction: 'mocked',
          status: 'passed',
          turns: [],
          durationMs: 50,
          retried: false,
        };
      });

      const events: { type: string; name?: string }[] = [];
      await manager.executeSteps(
        'session-1',
        { steps: ['[output: firstName] [output: lastName] Get the user details'] },
        (event) => events.push(event as any),
      );

      const captures = events.filter((e) => e.type === 'capture');
      expect(captures.map((c) => c.name).sort()).toEqual(['firstName', 'lastName']);
    });

    it('does NOT emit a capture event when [output:] var was not actually extracted', async () => {
      vi.mocked(executeStep).mockClear();
      // Mock returns without setting resolvedParameters['orderId']
      vi.mocked(executeStep).mockImplementationOnce(async () => ({
        index: 1,
        instruction: 'mocked',
        status: 'passed',
        turns: [],
        durationMs: 50,
        retried: false,
      }));

      const events: { type: string }[] = [];
      await manager.executeSteps(
        'session-1',
        { steps: ['[output: missingVar] Try to get something'] },
        (event) => events.push(event as any),
      );

      const captures = events.filter((e) => e.type === 'capture');
      expect(captures).toHaveLength(0);
    });

    it('parses single [output: var] prefix correctly', async () => {
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, instruction, opts) => {
        // The instruction should have the [output:] stripped and [store as:] appended
        expect(instruction).toContain('[store as: orderId]');
        expect(instruction).not.toContain('[output:');
        if (opts.resolvedParameters) {
          opts.resolvedParameters['orderId'] = 'ABC';
        }
        return {
          index: 1,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: 50,
          retried: false,
        };
      });

      const response = await manager.executeSteps('session-1', {
        steps: ['[output: orderId] Get the order ID from the page'],
      });

      expect(response.results[0]!.outputs).toHaveProperty('orderId', 'ABC');
    });

    it('parses multiple [output: var] prefixes correctly', async () => {
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, instruction, opts) => {
        expect(instruction).toContain('[store as: first, second]');
        if (opts.resolvedParameters) {
          opts.resolvedParameters['first'] = 'val1';
          opts.resolvedParameters['second'] = 'val2';
        }
        return {
          index: 1,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: 50,
          retried: false,
        };
      });

      const response = await manager.executeSteps('session-1', {
        steps: ['[output: first] [output: second] Get both values'],
      });

      expect(response.results[0]!.outputs).toHaveProperty('first', 'val1');
      expect(response.results[0]!.outputs).toHaveProperty('second', 'val2');
    });

    it('handles steps with no output prefixes', async () => {
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, instruction) => {
        // Instruction should be passed through unchanged
        expect(instruction).toBe('Click the login button');
        return {
          index: 1,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: 50,
          retried: false,
        };
      });

      const response = await manager.executeSteps('session-1', {
        steps: ['Click the login button'],
      });

      expect(response.results[0]!.outputs).toEqual({});
    });

    it('tags request parameters as source "parameter" in outputSources', async () => {
      const response = await manager.executeSteps('session-1', {
        steps: ['Click the button'],
        parameters: { username: 'alice', region: 'eu' },
      });

      expect(response.outputs).toMatchObject({ username: 'alice', region: 'eu' });
      expect(response.outputSources).toMatchObject({
        username: 'parameter',
        region: 'parameter',
      });
    });

    it('tags [output:] captures as source "capture" in outputSources', async () => {
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, instruction, opts) => {
        if (opts.resolvedParameters) {
          opts.resolvedParameters['orderId'] = 'ORD-1';
        }
        return {
          index: 1,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: 50,
          retried: false,
        };
      });

      const response = await manager.executeSteps('session-1', {
        steps: ['[output: orderId] Get the order ID'],
      });

      expect(response.outputs).toMatchObject({ orderId: 'ORD-1' });
      expect(response.outputSources).toMatchObject({ orderId: 'capture' });
    });

    it('keeps the "parameter" label when a same-named capture overwrites the value (first-write-wins)', async () => {
      // The collision case: a value seeded as a parameter stays labelled
      // 'parameter' even after a later [output:] capture overwrites the
      // value, preserving the variable's original identity.
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, instruction, opts) => {
        if (opts.resolvedParameters) {
          // A capture re-extracts the same name with a new value.
          opts.resolvedParameters['token'] = 'captured-value';
        }
        return {
          index: 1,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: 50,
          retried: false,
        };
      });

      const response = await manager.executeSteps('session-1', {
        steps: ['[output: token] Re-read the token'],
        parameters: { token: 'param-value' },
      });

      // Value follows last-write (the capture); label stays the first source.
      expect(response.outputs).toMatchObject({ token: 'captured-value' });
      expect(response.outputSources).toMatchObject({ token: 'parameter' });
    });

    it('tags skill ## Outputs as source "toolOutput" in outputSources', async () => {
      // A skill output reaches session scope via a rewritten `[store as:]`,
      // which is otherwise indistinguishable from a plain page capture. The
      // expander surfaces the effective output name and the server seeds the
      // 'toolOutput' label from it — so this must NOT fall through to 'capture'.
      const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-skill-'));
      await fs.writeFile(
        path.join(skillsDir, 'fetch_order.md'),
        `---
type: skill
---
# fetch_order
## Outputs
- order_id
## Steps
1. Read the order id [store as: order_id]
`,
      );

      // Simulate the step executor storing the aliased output into scope.
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, instruction, opts) => {
        if (opts.resolvedParameters) opts.resolvedParameters['myOrder'] = 'ORD-9';
        return {
          index: 1,
          instruction,
          status: 'passed',
          turns: [],
          durationMs: 50,
          retried: false,
        };
      });

      const response = await manager.executeSteps('session-1', {
        steps: ['[skill: fetch_order out.order_id="myOrder"]'],
        skillsDir,
      });

      await fs.rm(skillsDir, { recursive: true, force: true });

      expect(response.outputs).toMatchObject({ myOrder: 'ORD-9' });
      expect(response.outputSources).toMatchObject({ myOrder: 'toolOutput' });
    });

    it('passes distinct frame-scoped cache keys for one skill invoked on two steps (issue 016 / Bug 1)', async () => {
      // Plumbing regression guard for the Bug 1 fix. Two invocations of ONE
      // skill expand to the SAME skill-file line; before the fix they shared a
      // step-<line>.json so the second replayed the first's actions. The fix
      // qualifies the cache key with the per-invocation frame the expander
      // mints. This asserts the cacheKey the SERVER hands executeStep — so it
      // fails if the expander stops minting distinct frames OR session-manager
      // regresses to passing the bare source line instead of the frame key.
      // (The cacheKey opt is sent unconditionally, so no cache/project root
      // setup is needed — only skillsDir, to make expansion mint frames.)
      const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-skill-key-'));
      await fs.writeFile(
        path.join(skillsDir, 'echo.md'),
        `---
type: skill
---
# echo
## Parameters
- msg: the message
## Steps
1. Note "{{msg}}"
`,
      );

      await manager.executeSteps('session-1', {
        steps: ['[skill: echo msg="first"]', '[skill: echo msg="second"]'],
        skillsDir,
      });

      await fs.rm(skillsDir, { recursive: true, force: true });

      // The default executeStep mock ran once per expanded skill-body step;
      // read the cacheKey opt the SERVER handed it (4th arg). Using mock.calls
      // rather than a custom mockImplementation avoids leaking an implementation
      // into later tests (the suite's beforeEach clears calls, not impls).
      const cacheKeys = vi.mocked(executeStep).mock.calls.map((c) => c[3]?.cacheKey);
      // One body step per invocation → two executeStep calls.
      expect(cacheKeys).toHaveLength(2);
      // The collision was identical keys; the fix differs them by frame only.
      expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
      const [frameA, lineA] = String(cacheKeys[0]).split('-');
      const [frameB, lineB] = String(cacheKeys[1]).split('-');
      expect(frameA).toMatch(/^f\d+$/);   // frame-scoped, not a bare line
      expect(frameB).toMatch(/^f\d+$/);
      expect(frameA).not.toBe(frameB);    // distinct invocation frames (f1 vs f2)
      expect(lineA).toBe(lineB);          // same skill-body source line
    });

    it('invalidates the bundle cache when a skill body is edited (issue 016 / Bug 2)', async () => {
      // The bug: the bundle hash was over the pre-expansion test steps, so
      // editing what a skill DOES left the hash unchanged and stale skill steps
      // replayed. The fix hashes the EXPANDED document, so a skill-body edit
      // flips the hash and StepCache.initialize wipes the bundle. executeStep is
      // mocked, so the observable is the on-disk meta.json hash + a planted
      // sentinel cache file (StepCache.initialize runs in the manager, not the
      // executor).
      const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-bug2-edit-'));
      await fs.writeFile(path.join(projectRoot, 'aiui.config.json'), '{}'); // project marker
      const skillsDir = path.join(projectRoot, 'skills');
      await fs.mkdir(skillsDir);
      const skillPath = path.join(skillsDir, 'greet.md');
      const writeGreet = (line: string) =>
        fs.writeFile(skillPath, `---\ntype: skill\n---\n# greet\n## Steps\n1. ${line}\n`);
      await writeGreet('Say hello');
      const testFilePath = path.join(projectRoot, 'tests', 't.md');
      const req = {
        steps: ['[skill: greet]'],
        fullSteps: ['[skill: greet]'],
        skillsDir,
        testFilePath,
        cacheEnabled: true,
      };

      // Run 1 — populates the bundle.
      await manager.executeSteps('bug2-edit-1', req);
      const cacheDir = path.join(projectRoot, '.cache', sanitizeTestName(testFilePath));
      const meta1 = JSON.parse(await fs.readFile(path.join(cacheDir, 'meta.json'), 'utf-8'));
      // Plant a sentinel cached-step file so we can prove the wipe.
      const sentinel = path.join(cacheDir, 'step-sentinel.json');
      await fs.writeFile(sentinel, '{"turns":[]}');

      // Edit what the skill DOES, then re-run the same test request.
      await writeGreet('Say goodbye');
      await manager.executeSteps('bug2-edit-2', req);
      const meta2 = JSON.parse(await fs.readFile(path.join(cacheDir, 'meta.json'), 'utf-8'));

      await fs.rm(projectRoot, { recursive: true, force: true });

      expect(meta2.stepsHash).not.toBe(meta1.stepsHash); // edit reached the hash
      await expect(fs.readFile(sentinel, 'utf-8')).rejects.toThrow(); // bundle wiped
    });

    it('does NOT invalidate when an unchanged skill test is re-run — cache survives (issue 016 / Bug 2)', async () => {
      // Complement of the invalidate-on-edit test: re-running the SAME skill
      // test with no edits must keep the bundle hash stable so cached steps
      // survive. Guards against the fix over-invalidating (e.g. non-deterministic
      // expansion) and silently defeating the cache.
      const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-bug2-stable-'));
      await fs.writeFile(path.join(projectRoot, 'aiui.config.json'), '{}');
      const skillsDir = path.join(projectRoot, 'skills');
      await fs.mkdir(skillsDir);
      await fs.writeFile(path.join(skillsDir, 'greet.md'), `---\ntype: skill\n---\n# greet\n## Steps\n1. Say hello\n`);
      const testFilePath = path.join(projectRoot, 'tests', 't.md');
      const req = { steps: ['[skill: greet]'], fullSteps: ['[skill: greet]'], skillsDir, testFilePath, cacheEnabled: true };

      await manager.executeSteps('stable-1', req);
      const cacheDir = path.join(projectRoot, '.cache', sanitizeTestName(testFilePath));
      const meta1 = JSON.parse(await fs.readFile(path.join(cacheDir, 'meta.json'), 'utf-8'));
      // Plant a sentinel cached-step file; an unchanged re-run must NOT wipe it.
      const sentinel = path.join(cacheDir, 'step-sentinel.json');
      await fs.writeFile(sentinel, '{"turns":[]}');

      // Re-run with NO edits.
      await manager.executeSteps('stable-2', req);
      const meta2 = JSON.parse(await fs.readFile(path.join(cacheDir, 'meta.json'), 'utf-8'));
      const sentinelSurvived = await fs.readFile(sentinel, 'utf-8').then(() => true, () => false);

      await fs.rm(projectRoot, { recursive: true, force: true });

      expect(meta2.stepsHash).toBe(meta1.stepsHash); // hash stable across re-run
      expect(sentinelSurvived).toBe(true); // bundle NOT wiped — cache survives
    });

    it('full-run and resumed-subset-batch hashes match for the same document (issue 016 / Bug 2)', async () => {
      // A paused/resumed run sends a subset batch but the same fullSteps. The
      // fix expands the FULL document for a subset batch's hash, so it matches
      // the full run's — otherwise the cache would never hit across a pause. Two
      // invocations + an internal var (`v`) make the seq-based __skillN_
      // namespacing diverge if a subset wrongly hashed only its own expansion.
      const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-bug2-batch-'));
      await fs.writeFile(path.join(projectRoot, 'aiui.config.json'), '{}');
      const skillsDir = path.join(projectRoot, 'skills');
      await fs.mkdir(skillsDir);
      await fs.writeFile(
        path.join(skillsDir, 'cap.md'),
        `---\ntype: skill\n---\n# cap\n## Steps\n1. Read the value [store as: v]\n2. Use {{v}}\n`,
      );
      const testFilePath = path.join(projectRoot, 'tests', 't.md');
      const fullSteps = ['[skill: cap]', '[skill: cap]'];
      const cacheDir = path.join(projectRoot, '.cache', sanitizeTestName(testFilePath));

      // Full run: steps == fullSteps.
      await manager.executeSteps('batch-full', { steps: fullSteps, fullSteps, skillsDir, testFilePath, cacheEnabled: true });
      const hFull = JSON.parse(await fs.readFile(path.join(cacheDir, 'meta.json'), 'utf-8')).stepsHash;

      // Resumed subset batch: only the 2nd invocation, same fullSteps.
      await manager.executeSteps('batch-resume', { steps: [fullSteps[1]!], fullSteps, skillsDir, testFilePath, cacheEnabled: true });
      const hSubset = JSON.parse(await fs.readFile(path.join(cacheDir, 'meta.json'), 'utf-8')).stepsHash;

      await fs.rm(projectRoot, { recursive: true, force: true });

      expect(hSubset).toBe(hFull); // batch-stable: the subset re-expands the full doc
    });

    it('hashes raw steps for a no-skills test (no Bug 2 regression)', async () => {
      const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-bug2-noskill-'));
      await fs.writeFile(path.join(projectRoot, 'aiui.config.json'), '{}');
      const testFilePath = path.join(projectRoot, 'tests', 't.md');
      const steps = ['Click login', 'Type username'];

      await manager.executeSteps('noskill', { steps, fullSteps: steps, testFilePath, cacheEnabled: true });
      const cacheDir = path.join(projectRoot, '.cache', sanitizeTestName(testFilePath));
      const meta = JSON.parse(await fs.readFile(path.join(cacheDir, 'meta.json'), 'utf-8'));

      await fs.rm(projectRoot, { recursive: true, force: true });

      expect(meta.stepsHash).toBe(computeStepsHash(steps)); // raw steps, byte-identical to pre-fix
    });

    it('invalidates the cache when a ${data.*} value is edited (issue 018)', async () => {
      // The bug: the bundle hash was over the RAW step text with ${data.x}
      // intact, so editing the VALUE behind it left the hash unchanged and a
      // stale action replayed. The fix interpolates env/data into the hash
      // source, so a data-file edit flips the hash and StepCache.initialize
      // wipes the bundle. executeStep is mocked, so the observable is meta.json's
      // hash + a planted sentinel cache file. (Pre-fix this test FAILS: both
      // runs hash "Search for ${data.query}" identically and the sentinel
      // survives.)
      const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-018-data-'));
      await fs.writeFile(path.join(projectRoot, 'aiui.config.json'), '{}'); // marker; dataDir defaults to 'data'
      await fs.writeFile(path.join(projectRoot, '.env.dev'), ''); // env files are a hard error if missing when envName is set
      await fs.mkdir(path.join(projectRoot, 'data'));
      const dataPath = path.join(projectRoot, 'data', 'dev.json');
      await fs.writeFile(dataPath, JSON.stringify({ query: 'laptops' }));
      const testFilePath = path.join(projectRoot, 'tests', 't.md');
      const req = {
        steps: ['Search for ${data.query}'],
        fullSteps: ['Search for ${data.query}'],
        testFilePath,
        envName: 'dev',
        cacheEnabled: true,
      };

      // Run 1 — resolves "Search for laptops" into the hash, populates the bundle.
      await manager.executeSteps('018-data-1', req);
      const cacheDir = path.join(projectRoot, '.cache', sanitizeTestName(testFilePath));
      const meta1 = JSON.parse(await fs.readFile(path.join(cacheDir, 'meta.json'), 'utf-8'));
      const sentinel = path.join(cacheDir, 'step-sentinel.json');
      await fs.writeFile(sentinel, '{"turns":[]}');

      // Edit the data VALUE (step text unchanged). We explicitly bump the mtime
      // because the bundle reload is gated on mtime equality (issue 011), and on
      // some filesystems an immediate rewrite reuses the same coarse mtime tick —
      // which would NOT reload and would mask this fix. utimes makes the reload
      // deterministic; a human-paced "save and re-run" differs in mtime naturally.
      // (That same-tick gap is an issue-011 limitation, not issue-018.)
      await fs.writeFile(dataPath, JSON.stringify({ query: 'phones' }));
      const future = new Date(Date.now() + 2000);
      await fs.utimes(dataPath, future, future);

      await manager.executeSteps('018-data-2', req);
      const meta2 = JSON.parse(await fs.readFile(path.join(cacheDir, 'meta.json'), 'utf-8'));
      // Capture the sentinel's fate BEFORE removing the project dir — otherwise
      // the rm would delete it unconditionally and the check would be vacuous.
      const sentinelGone = await fs.readFile(sentinel, 'utf-8').then(() => false, () => true);

      await fs.rm(projectRoot, { recursive: true, force: true });

      // The hash is the INTERPOLATED step text, so it moved laptops → phones.
      // Pinning to the resolved form proves the fix is engaged: pre-fix BOTH
      // runs would hash computeStepsHash(['Search for ${data.query}']) and these
      // two assertions fail.
      expect(meta1.stepsHash).toBe(computeStepsHash(['Search for laptops']));
      expect(meta2.stepsHash).toBe(computeStepsHash(['Search for phones']));
      expect(sentinelGone).toBe(true); // initialize() wiped the bundle → no stale replay
    });

    it('does NOT invalidate when an UNREFERENCED data key changes — cache survives (issue 018)', async () => {
      // Precision: the hash is over the interpolated STEP TEXT, not the whole
      // data file. Editing a key no step references keeps the hash stable so
      // the cache survives, even though the bundle reloads with fresh data.
      // Guards against over-invalidation (e.g. a crude data-file-mtime wipe
      // that would blow away caches for every test sharing a dataSources file).
      const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-018-precise-'));
      await fs.writeFile(path.join(projectRoot, 'aiui.config.json'), '{}');
      await fs.writeFile(path.join(projectRoot, '.env.dev'), ''); // env files are a hard error if missing when envName is set
      await fs.mkdir(path.join(projectRoot, 'data'));
      const dataPath = path.join(projectRoot, 'data', 'dev.json');
      await fs.writeFile(dataPath, JSON.stringify({ query: 'laptops', region: 'US' }));
      const testFilePath = path.join(projectRoot, 'tests', 't.md');
      const req = {
        steps: ['Search for ${data.query}'], // references query, NOT region
        fullSteps: ['Search for ${data.query}'],
        testFilePath,
        envName: 'dev',
        cacheEnabled: true,
      };

      await manager.executeSteps('018-precise-1', req);
      const cacheDir = path.join(projectRoot, '.cache', sanitizeTestName(testFilePath));
      const meta1 = JSON.parse(await fs.readFile(path.join(cacheDir, 'meta.json'), 'utf-8'));
      const sentinel = path.join(cacheDir, 'step-sentinel.json');
      await fs.writeFile(sentinel, '{"turns":[]}');

      // Edit ONLY the unreferenced key; force the bundle to reload (fresh data)
      // via an explicit mtime bump — otherwise a same-tick rewrite might not
      // reload and "survival" would be a missed reload, not precision (issue 011).
      await fs.writeFile(dataPath, JSON.stringify({ query: 'laptops', region: 'EU' }));
      const future = new Date(Date.now() + 2000);
      await fs.utimes(dataPath, future, future);

      await manager.executeSteps('018-precise-2', req);
      const meta2 = JSON.parse(await fs.readFile(path.join(cacheDir, 'meta.json'), 'utf-8'));
      const sentinelSurvived = await fs.readFile(sentinel, 'utf-8').then(() => true, () => false);

      await fs.rm(projectRoot, { recursive: true, force: true });

      // Fix is engaged: the hash is the INTERPOLATED text. Without this anchor the
      // test would pass even with the fix removed (raw ${data.query} is trivially
      // stable across any data edit) — i.e. it would guard nothing. Pre-fix this
      // equals computeStepsHash(['Search for ${data.query}']) and fails.
      expect(meta1.stepsHash).toBe(computeStepsHash(['Search for laptops']));
      // Precision: editing the unreferenced `region` left the resolved text — and
      // thus the hash — unchanged, so the cache survived.
      expect(meta2.stepsHash).toBe(meta1.stepsHash);
      expect(sentinelSurvived).toBe(true); // cache survives — no needless re-run
    });

    it('handles executeStep throwing an unexpected error', async () => {
      vi.mocked(executeStep).mockRejectedValueOnce(new Error('Browser crashed'));

      const response = await manager.executeSteps('session-1', {
        steps: ['Do something'],
      });

      expect(response.status).toBe('error');
      expect(response.error).toEqual({ step: 0, message: 'Browser crashed' });
      expect(response.results[0]!.status).toBe('error');
    });
  });

  describe('getSession', () => {
    it('returns state for active session', async () => {
      await manager.executeSteps('session-1', {
        steps: ['Click button'],
      });

      const state = await manager.getSession('session-1');
      expect(state).not.toBeNull();
      expect(state!.sessionId).toBe('session-1');
      expect(state!.status).toBe('active');
      expect(state!.totalStepsExecuted).toBe(1);
      expect(state!.outputs).toBeDefined();
    });

    it('returns null for nonexistent session', async () => {
      const state = await manager.getSession('does-not-exist');
      expect(state).toBeNull();
    });
  });

  describe('getActiveSessions', () => {
    it('returns list of active sessions', async () => {
      await manager.executeSteps('session-a', { steps: ['Step 1'] });
      await manager.executeSteps('session-b', { steps: ['Step 1'] });

      const sessions = manager.getActiveSessions();
      expect(sessions).toHaveLength(2);

      const ids = sessions.map((s) => s.sessionId);
      expect(ids).toContain('session-a');
      expect(ids).toContain('session-b');
    });
  });

  describe('closeSession', () => {
    it('closes browser and removes session', async () => {
      await manager.executeSteps('session-1', { steps: ['Step 1'] });

      const trackerForSession = browserTrackerInstances[browserTrackerInstances.length - 1]!;

      await manager.closeSession('session-1');

      expect(trackerForSession.closeAll).toHaveBeenCalled();
      const state = await manager.getSession('session-1');
      expect(state).toBeNull();
      expect(manager.getActiveSessions()).toHaveLength(0);
    });

    it('is a no-op for nonexistent session', async () => {
      // Should not throw
      await manager.closeSession('nonexistent');
    });
  });

  describe('subsequent request to closed session', () => {
    it('creates a new session', async () => {
      await manager.executeSteps('session-1', { steps: ['Step 1'] });
      await manager.closeSession('session-1');

      // This should create a brand new session
      const response = await manager.executeSteps('session-1', {
        steps: ['Step after reopen'],
      });

      expect(response.sessionId).toBe('session-1');
      expect(response.status).toBe('passed');

      const state = await manager.getSession('session-1');
      expect(state).not.toBeNull();
    });
  });
});
