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
const aiClientInstances: Array<{
  config: any;
  syncAuth: ReturnType<typeof vi.fn>;
  setAiPolicy: ReturnType<typeof vi.fn>;
}> = [];

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
    // Video recording: report 'off' so no recordVideo/finalize path runs under
    // the mock (the mocked BrowserSession has no real page.video()).
    // Real behaviour, not a stub: session-manager uses it to bound page reads
    // while listing, and a mock that resolved instantly would hide a hang.
    briefly: async (p: Promise<unknown>, ms: number, fallback: unknown) =>
      Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]),
    resolveVideoMode: vi.fn(() => 'off'),
    finalizeMainPageVideo: vi.fn(async (args: { closeContext: () => Promise<void> }) => {
      await args.closeContext();
      return undefined;
    }),
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
    setAiPolicy = vi.fn();
    syncAuth = vi.fn((model: string, apiKey: string | undefined, gatewayUrl?: string) => {
      const changed =
        model !== this.config.model ||
        apiKey !== this.config.apiKey ||
        (gatewayUrl !== undefined && gatewayUrl !== this.config.gatewayUrl);
      this.config = { ...this.config, model, apiKey };
      if (gatewayUrl !== undefined) this.config.gatewayUrl = gatewayUrl;
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
  buildReportBaseName: vi.fn((report: { testName: string }) => report.testName),
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
import { computeStepsHash, cacheDirName, envCacheSegment } from '../src/cache/step-cache.js';
import { generateReport } from '../src/report/generator.js';
import type { TestReport } from '../src/report/types.js';

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
    it('picks up a changed AI_MODEL/AI_API_KEY/AI_GATEWAY_URL on the next run and reverts removed keys to the server base', async () => {
      const sessionId = 'reuse-1';

      // Three runs on the SAME session — the reuse path that froze the model
      // before this fix. Each ships the .env-derived env map.
      await manager.executeSteps(sessionId, { steps: ['s1'], env: { AI_MODEL: 'model-A', AI_API_KEY: 'key-1' } });
      await manager.executeSteps(sessionId, {
        steps: ['s2'],
        env: { AI_MODEL: 'model-B', AI_GATEWAY_URL: 'https://llm.corp.example' },
      });
      await manager.executeSteps(sessionId, { steps: ['s3'] });

      // Session reused → exactly one AiClient built (not rebuilt per batch, so
      // browser state is preserved).
      expect(aiClientInstances).toHaveLength(1);
      const ai = aiClientInstances[0]!;

      // syncAuth runs at the top of every batch, recomputed from the server
      // base (testConfig.ai: model 'test-model', no apiKey, gateway
      // 'https://ai.test') — so a key omitted from a later .env reverts to base
      // rather than sticking on the prior override. The gateway rides along on
      // every call: it is baked into the client's baseURL at build time, so
      // "the value was resolved correctly" is not the same as "the session is
      // talking to it" (stories/keyless-replay-and-gateway-env.md).
      expect(ai.syncAuth.mock.calls).toEqual([
        ['model-A', 'key-1', 'https://ai.test'],                 // batch 1: model+key from env
        ['model-B', undefined, 'https://llm.corp.example'],      // batch 2: gateway from env; key reverts to base
        ['test-model', undefined, 'https://ai.test'],            // batch 3: empty env → all revert to base
      ]);
      // And the live client reflects the final state.
      expect(ai.config.model).toBe('test-model');
      expect(ai.config.apiKey).toBeUndefined();
      expect(ai.config.gatewayUrl).toBe('https://ai.test');
    });
  });

  describe('the compile/errand carve-out from the AI switch', () => {
    // stories/run-settings.md §9. `POST /codebehind/compile` drives this same
    // machinery in process, and its request carries no `compile` field — so the
    // wire-derived carve-out on the step route does not cover it and this flag
    // has to. A keyed manager, because the switch is only meaningful with one.
    const keyed = { ...testConfig, ai: { ...testConfig.ai, apiKey: 'k' } };

    /** The options object the executor got on the Nth (0-based) step call. */
    const optsAt = (call: number): Record<string, unknown> =>
      vi.mocked(executeStep).mock.calls[call]![3] as unknown as Record<string, unknown>;

    it('ignores a retained `ai: off` for an in-process request FOR AI', async () => {
      const manager2 = new SessionManager(keyed);
      await manager2.executeSteps('carve', { steps: ['s1'], runSettings: { ai: 'off' } });
      expect(optsAt(0)['keyless']).toBe(true);

      await manager2.executeSteps('carve', { steps: ['s2'] }, undefined, undefined, {
        bypassAiPolicy: true,
      });

      expect(optsAt(1)).not.toHaveProperty('keyless');
      expect(aiClientInstances[0]!.setAiPolicy.mock.calls).toEqual([[false], [true]]);
    });

    it('does not retain the bypass — the next ordinary run is off again', async () => {
      // The trap §9 names: compile sending `runSettings: {ai: "on"}` instead
      // would be merged onto the session and silently clobber the caller's
      // standing `off` for every later run.
      const manager2 = new SessionManager(keyed);
      await manager2.executeSteps('carve-keep', { steps: ['s1'], runSettings: { ai: 'off' } });
      await manager2.executeSteps('carve-keep', { steps: ['s2'] }, undefined, undefined, {
        bypassAiPolicy: true,
      });
      await manager2.executeSteps('carve-keep', { steps: ['s3'] });

      expect(optsAt(2)['keyless']).toBe(true);
      expect(manager2.getRunSettings('carve-keep')?.session?.overrides).toEqual({ ai: 'off' });
    });

    it('does not conjure AI out of the bypass on a keyless server', async () => {
      // It lifts a POLICY. A compile on a machine with no model is still a
      // compile with no model, and the executor has to keep hearing so.
      const manager2 = new SessionManager(testConfig);
      await manager2.executeSteps('carve-keyless', { steps: ['s1'] }, undefined, undefined, {
        bypassAiPolicy: true,
      });

      expect(optsAt(0)['keyless']).toBe(true);
      expect(optsAt(0)).not.toHaveProperty('keylessReason');
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

    // ── issue 021: stopped-run report delivery + content ───────────────
    describe('stopped-run report + token delivery (issue 021)', () => {
      /** Make step N abort the run mid-flight, returning the swallowed-abort shape. */
      const abortOnStep = (ac: AbortController, abortAtCall: number) => {
        let calls = 0;
        vi.mocked(executeStep).mockImplementation(async (_l, _t, _i, _opts: any): Promise<StepResult> => {
          calls++;
          if (calls < abortAtCall) {
            return { index: calls, instruction: `step ${calls}`, status: 'passed', turns: [], durationMs: 5, retried: false };
          }
          ac.abort();
          return { index: calls, instruction: `step ${calls}`, status: 'failed', turns: [], durationMs: 5, retried: true, error: 'Aborted by client' };
        });
      };

      it('records last-run info (reportPath + tokens, finalized) retrievable via getLastRun after a stop', async () => {
        const ac = new AbortController();
        abortOnStep(ac, 2); // step 1 passes, stop during step 2
        await manager.executeSteps('s021-a', { steps: ['one', 'two', 'three'] }, undefined, ac.signal);

        const info = manager.getLastRun('s021-a');
        expect(info.finalized).toBe(true);
        expect(info.reportPath).toBe('/tmp/fake-report.html'); // from the generateReport mock
        expect(info.tokens).toEqual({ total: 0, input: 0, output: 0 }); // mocked tracker → 0s, but present + frozen
      });

      it('generates a report marked aborted with the interrupted step recorded', async () => {
        const ac = new AbortController();
        abortOnStep(ac, 2);
        await manager.executeSteps('s021-b', { steps: ['one', 'two', 'three'] }, undefined, ac.signal);

        const report = vi.mocked(generateReport).mock.calls.at(-1)?.[0] as TestReport;
        expect(report.aborted).toBe(true);
        const interrupted = report.steps.filter((s) => s.interrupted);
        expect(interrupted).toHaveLength(1);
        expect(interrupted[0]!.index).toBe(2);
        // The interrupted step is excluded from the failed count.
        expect(report.failedSteps).toBe(0);
      });

      it('still produces a report when stopped during step 1 (Gap 3)', async () => {
        const ac = new AbortController();
        abortOnStep(ac, 1); // stop during the very first step
        await manager.executeSteps('s021-c', { steps: ['one', 'two'] }, undefined, ac.signal);

        // A report was generated (fullStepResults non-empty thanks to the
        // recorded interrupted step) and last-run info is retrievable.
        expect(generateReport).toHaveBeenCalled();
        const info = manager.getLastRun('s021-c');
        expect(info.finalized).toBe(true);
        expect(info.reportPath).toBe('/tmp/fake-report.html');
        const report = vi.mocked(generateReport).mock.calls.at(-1)?.[0] as TestReport;
        expect(report.steps.some((s) => s.interrupted)).toBe(true);
      });

      it('getLastRun returns finalized:false for an unknown session', () => {
        const info = manager.getLastRun('never-ran');
        expect(info.finalized).toBe(false);
        expect(info.reportPath).toBeUndefined();
      });

      it('a normal (non-aborted) run is unmarked: no report.aborted, emits step:fail on real failure', async () => {
        vi.mocked(executeStep).mockImplementation(async (): Promise<StepResult> => ({
          index: 1, instruction: 'boom', status: 'failed', turns: [], durationMs: 5, retried: false, error: 'real failure',
        }));
        const events: { type: string }[] = [];
        const response = await manager.executeSteps('s021-d', { steps: ['boom'] }, (e) => events.push(e as any));

        expect(response.status).toBe('failed');
        expect(events.some((e) => e.type === 'step:fail')).toBe(true);
        const report = vi.mocked(generateReport).mock.calls.at(-1)?.[0] as TestReport;
        expect(report.aborted).toBeUndefined();
        expect(report.steps.some((s) => s.interrupted)).toBeFalsy();
      });
    });

    // ── issue 030: last-run info is reset at run START so a STOP recovers THIS
    //    run's report, not a previously-finished run's stale one ──────────────
    describe('last-run info reset at run start (issue 030)', () => {
      it('a re-run clears the prior run\'s finalized report so a mid-run STOP recovers THIS run, not the previous one', async () => {
        // Run 1: a normal completed run records finalized last-run info.
        await manager.executeSteps('s030', { steps: ['one', 'two'] });
        const afterRun1 = manager.getLastRun('s030');
        expect(afterRun1.finalized).toBe(true);
        expect(afterRun1.reportPath).toBe('/tmp/fake-report.html');

        // Run 2 on the SAME session. Read last-run info MID-run (first step:pass),
        // BEFORE run 2 finalizes. Without the reset this still returns run 1's
        // stale { finalized: true, reportPath }, so a client that STOPS here and
        // polls "until finalized" recovers the PREVIOUS (passed) report. With the
        // reset it must be finalized:false with no report path.
        let midRun: { finalized: boolean; reportPath?: string } | undefined;
        await manager.executeSteps('s030', { steps: ['one', 'two'] }, (event) => {
          if (midRun === undefined && event.type === 'step:pass') {
            midRun = manager.getLastRun('s030');
          }
        });

        expect(midRun).toBeDefined();
        expect(midRun!.finalized).toBe(false);      // reset at run start (the fix)
        expect(midRun!.reportPath).toBeUndefined();  // no stale report path leaks
      });
    });

    // ── issue 031: a run that exits early during setup still FINALIZES last-run
    //    info, so a STOP-recovery poll terminates instead of hanging ──────────
    describe('early-exit runs still finalize last-run info (issue 031)', () => {
      it('a partial-rerun refusal (early setup exit) leaves getLastRun finalized, not hanging', async () => {
        const response = await manager.executeSteps('s031-refuse', {
          steps: ['Type {{__skill1_token}} into the box'],
          sourceLines: [10],
          testFilePath: '/proj/test.md',
          startAt: { uri: '/proj/test.md', line: 10 },
          seedScope: {},
        });
        // Refused early — before the step loop — so no report is written.
        expect(response.status).toBe('error');
        expect(executeStep).not.toHaveBeenCalled();

        // Even so, last-run info must be FINALIZED — otherwise a client polling
        // GET /sessions/:id/last-run "until finalized" (issue 021 stop-recovery)
        // hangs forever. (finalized:false here without the run-exit guarantee.)
        const info = manager.getLastRun('s031-refuse');
        expect(info.finalized).toBe(true);
        expect(info.reportPath).toBeUndefined(); // no report for a setup failure
      });
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

    it('emits a capture event for a read/count `as` capture with no [output:] prefix (issue 042)', async () => {
      vi.mocked(executeStep).mockClear();
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, _instruction, opts) => {
        if (opts.resolvedParameters) {
          opts.resolvedParameters['total_available'] = '$37.77';
        }
        return {
          index: 1,
          instruction: 'mocked',
          status: 'passed',
          turns: [
            {
              turnNumber: 1,
              attemptNumber: 1,
              timestamp: new Date().toISOString(),
              aiInteractions: [],
              subActions: [
                {
                  index: 1,
                  action: {
                    action: 'read',
                    selector: '[aria-label="Total available credits: $37.77"]',
                    as: 'total_available',
                    description: 'Extract the dollar amount next to Total available',
                  },
                  durationMs: 10,
                },
              ],
            },
          ],
          durationMs: 50,
          retried: false,
        };
      });

      const events: { type: string; line?: number; name?: string; value?: string }[] = [];
      const response = await manager.executeSteps(
        'session-1',
        {
          steps: [
            'Read the Credits page and identify the dollar amount displayed next to "TOTAL AVAILABLE". Return only the extracted dollar amount.',
          ],
        },
        (event) => events.push(event as any),
      );

      const captures = events.filter((e) => e.type === 'capture');
      expect(captures).toHaveLength(1);
      expect(captures[0]).toEqual({
        type: 'capture',
        line: 1,
        name: 'total_available',
        value: '$37.77',
        source: 'capture',
      });
      expect(response.results[0]!.outputs).toHaveProperty('total_available', '$37.77');
      expect(response.outputSources).toMatchObject({ total_available: 'capture' });
    });

    it('does not double-emit when [output:] and the action `as` name agree', async () => {
      vi.mocked(executeStep).mockClear();
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, _instruction, opts) => {
        if (opts.resolvedParameters) {
          opts.resolvedParameters['orderId'] = 'ORD-1';
        }
        return {
          index: 1,
          instruction: 'mocked',
          status: 'passed',
          turns: [
            {
              turnNumber: 1,
              attemptNumber: 1,
              timestamp: new Date().toISOString(),
              aiInteractions: [],
              subActions: [
                {
                  index: 1,
                  action: { action: 'read', selector: '#order', as: 'orderId', description: 'Get the order ID' },
                  durationMs: 10,
                },
              ],
            },
          ],
          durationMs: 50,
          retried: false,
        };
      });

      const events: { type: string; name?: string }[] = [];
      await manager.executeSteps(
        'session-1',
        { steps: ['[output: orderId] Get the order ID'] },
        (event) => events.push(event as any),
      );

      const captures = events.filter((e) => e.type === 'capture');
      expect(captures).toHaveLength(1);
    });

    it('never auto-surfaces a __skill*-namespaced `as` capture (issue 042 review)', async () => {
      vi.mocked(executeStep).mockClear();
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, _instruction, opts) => {
        if (opts.resolvedParameters) {
          opts.resolvedParameters['__skill1_total'] = '$37.77';
        }
        return {
          index: 1,
          instruction: 'mocked',
          status: 'passed',
          turns: [
            {
              turnNumber: 1,
              attemptNumber: 1,
              timestamp: new Date().toISOString(),
              aiInteractions: [],
              subActions: [
                {
                  index: 1,
                  action: { action: 'read', selector: '#total', as: '__skill1_total', description: 'internal skill capture' },
                  durationMs: 10,
                },
              ],
            },
          ],
          durationMs: 50,
          retried: false,
        };
      });

      const events: { type: string; name?: string }[] = [];
      const response = await manager.executeSteps(
        'session-1',
        { steps: ['Read the total'] },
        (event) => events.push(event as any),
      );

      const captures = events.filter((e) => e.type === 'capture');
      expect(captures).toHaveLength(0);
      expect(response.results[0]!.outputs).not.toHaveProperty('__skill1_total');
      expect(response.outputSources).not.toHaveProperty('__skill1_total');
    });

    it('does not re-emit a stale value when this step\'s `as` action failed (name captured by an earlier step)', async () => {
      vi.mocked(executeStep).mockClear();
      // Step 1: a successful read captures orderId, no [output:] prefix.
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, _instruction, opts) => {
        if (opts.resolvedParameters) {
          opts.resolvedParameters['orderId'] = 'ORD-1';
        }
        return {
          index: 1,
          instruction: 'mocked',
          status: 'passed',
          turns: [
            {
              turnNumber: 1,
              attemptNumber: 1,
              timestamp: new Date().toISOString(),
              aiInteractions: [],
              subActions: [
                {
                  index: 1,
                  action: { action: 'read', selector: '#order', as: 'orderId', description: 'Get the order ID' },
                  durationMs: 10,
                },
              ],
            },
          ],
          durationMs: 50,
          retried: false,
        };
      });
      // Step 2: a read reusing the same `as` name FAILS — resolvedParameters
      // still holds step 1's value (never cleared), but this step must not
      // re-emit it as if step 2 had captured it.
      vi.mocked(executeStep).mockImplementationOnce(async () => ({
        index: 2,
        instruction: 'mocked',
        status: 'passed',
        turns: [
          {
            turnNumber: 1,
            attemptNumber: 1,
            timestamp: new Date().toISOString(),
            aiInteractions: [],
            subActions: [
              {
                index: 1,
                action: { action: 'read', selector: '#order-2', as: 'orderId', description: 'Get the order ID again' },
                durationMs: 10,
                error: 'read pattern matched nothing',
              },
            ],
          },
        ],
        durationMs: 50,
        retried: false,
      }));

      const events: { type: string; name?: string }[] = [];
      await manager.executeSteps(
        'session-1',
        { steps: ['Get the order ID', 'Get the order ID again'] },
        (event) => events.push(event as any),
      );

      const captures = events.filter((e) => e.type === 'capture');
      expect(captures).toHaveLength(1);
      expect(captures[0]!.line).toBe(1);
    });

    it('threads a captured `as` value into the report step as `outputs` (issue 042)', async () => {
      vi.mocked(executeStep).mockClear();
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, _instruction, opts) => {
        if (opts.resolvedParameters) {
          opts.resolvedParameters['total_available'] = '37.76';
        }
        return {
          index: 1,
          instruction: 'mocked',
          status: 'passed',
          turns: [
            {
              turnNumber: 1,
              attemptNumber: 1,
              timestamp: new Date().toISOString(),
              aiInteractions: [],
              subActions: [
                {
                  index: 1,
                  action: { action: 'read', selector: '#total', as: 'total_available', description: 'Extract the total available' },
                  durationMs: 10,
                },
              ],
            },
          ],
          durationMs: 50,
          retried: false,
        };
      });

      await manager.executeSteps('session-1', {
        steps: ['Extract the total available in $ amount'],
      });

      const report = vi.mocked(generateReport).mock.calls.at(-1)?.[0] as TestReport;
      expect(report.steps[0]!.outputs).toEqual({ total_available: '37.76' });
    });

    it('omits `outputs` on the report step entirely when nothing was captured', async () => {
      vi.mocked(executeStep).mockClear();
      vi.mocked(executeStep).mockImplementationOnce(async (_idx, _total, instruction) => ({
        index: 1,
        instruction,
        status: 'passed',
        turns: [],
        durationMs: 50,
        retried: false,
      }));

      await manager.executeSteps('session-1', { steps: ['Click the login button'] });

      const report = vi.mocked(generateReport).mock.calls.at(-1)?.[0] as TestReport;
      expect(report.steps[0]!.outputs).toBeUndefined();
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

    it('tags a Set assignment as source "assignment" in outputSources', async () => {
      const response = await manager.executeSteps('session-1', {
        steps: ['Set {{summary}} to "hello, {{who}}"'],
        parameters: { who: 'world' },
      });

      expect(response.outputs).toMatchObject({ summary: 'hello, world' });
      expect(response.outputSources).toMatchObject({ summary: 'assignment' });
    });

    it('does not relabel a parameter a later Set rewrites', async () => {
      // `outputSources` documents itself as keeping a variable's ORIGINAL
      // identity rather than hiding it behind the latest source, and every
      // other write site is first-write-wins. The Set branch wrote
      // unconditionally, which moved a `## Parameters` value out of the
      // Parameters section of any client that groups by this.
      const response = await manager.executeSteps('session-1', {
        steps: ['Set {{region}} to "au"'],
        parameters: { region: 'eu' },
      });

      expect(response.outputs).toMatchObject({ region: 'au' });
      expect(response.outputSources).toMatchObject({ region: 'parameter' });
    });

    it('keeps a __proto__ assignment in session.outputs across the wire', async () => {
      // `session.outputs` is a plain object, so `outputs['__proto__'] =`
      // creates no own key: the value resolved inside the batch and then
      // vanished from the HTTP outputs map and from the next batch's seed.
      // Round two fixed it and shipped no test; a revert to plain assignment
      // left all 3709 tests green.
      const response = await manager.executeSteps('session-1', {
        steps: ['Set {{__proto__}} to "danger"'],
      });

      // Deliberately NOT `toMatchObject({ __proto__: 'danger' })`: in an
      // object literal that key is the prototype-setter form, ignored for a
      // string, so the expected object is `{}` and the assertion passes
      // against anything. Found by review — in the test whose whole subject
      // is that exact hazard.
      expect(Object.getOwnPropertyDescriptor(response.outputs, '__proto__')?.value).toBe(
        'danger',
      );
      expect(Object.keys(response.outputs)).toContain('__proto__');
      // And it must be a plain own property, not a mutated prototype.
      expect(Object.getPrototypeOf(response.outputs)).toBe(Object.prototype);
    });

    it('fails the step, rather than the request, on an unresolvable ${...}', async () => {
      // `interpolateEnvData` throws on an unknown reference, and the run loop
      // has no catch above it — so a bad reference inside a Set template
      // escaped as a server error instead of failing its own step. The guard
      // added for it was unreachable until the pre-loop interpolation (which
      // feeds the grouper) also learned to skip Set steps.
      const response = await manager.executeSteps('session-1', {
        steps: ['Set {{note}} to "${data.nope}"'],
        envName: 'test',
        env: { AI_API_KEY: 'k' },
      });

      expect(response.status).toBe('failed');
      expect(String(response.error?.message)).toContain('${data.nope}');
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
      // No envName on this request → the `default` env segment; the dir name is
      // path-derived (issues 027/028), not the title.
      const cacheDir = path.join(projectRoot, '.cache', envCacheSegment(undefined), cacheDirName(testFilePath, projectRoot));
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
      // No envName → `default` segment; path-derived dir name.
      const cacheDir = path.join(projectRoot, '.cache', envCacheSegment(undefined), cacheDirName(testFilePath, projectRoot));
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
      // No envName → `default` segment; path-derived dir name.
      const cacheDir = path.join(projectRoot, '.cache', envCacheSegment(undefined), cacheDirName(testFilePath, projectRoot));

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
      // No envName → `default` segment; path-derived dir name.
      const cacheDir = path.join(projectRoot, '.cache', envCacheSegment(undefined), cacheDirName(testFilePath, projectRoot));
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
      // req.envName === 'dev' → the `dev` env segment (issue 012); path-derived
      // dir name (issues 027/028).
      const cacheDir = path.join(projectRoot, '.cache', envCacheSegment('dev'), cacheDirName(testFilePath, projectRoot));
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
      // req.envName === 'dev' → the `dev` env segment (issue 012); path-derived
      // dir name (issues 027/028).
      const cacheDir = path.join(projectRoot, '.cache', envCacheSegment('dev'), cacheDirName(testFilePath, projectRoot));
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

    describe('env-namespaced, path-keyed cache dir (issues 012 / 027 / 028)', () => {
      // These drive the WHOLE server seam (SessionManager.executeSteps), not a
      // unit of the path resolver. A request that silently dropped `envName`
      // between the wire and the on-disk dir would be caught here, because the
      // assertions read the directory the manager actually created — not what a
      // helper returns in isolation (memory lesson: test at the client seam).
      const STEPS = ['Click the only button'];

      it('the same test under two envs populates two distinct on-disk dirs; the second env does NOT read the first (issue 012)', async () => {
        const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-012-twoenv-'));
        await fs.writeFile(path.join(projectRoot, 'aiui.config.json'), '{}');
        // A missing `.env.<name>` is a hard error in the bundle resolver, so
        // both env files must exist for the request to run at all.
        await fs.writeFile(path.join(projectRoot, '.env.dev'), '');
        await fs.writeFile(path.join(projectRoot, '.env.staging'), '');
        const testFilePath = path.join(projectRoot, 'tests', 't.md');
        const baseReq = { steps: STEPS, fullSteps: STEPS, testFilePath, cacheEnabled: true };

        // The path-derived dir segment is identical across envs (same file);
        // only the env segment differs. That is the whole point of issue 012.
        const dirName = cacheDirName(testFilePath, projectRoot);
        const devDir = path.join(projectRoot, '.cache', envCacheSegment('dev'), dirName);
        const stagingDir = path.join(projectRoot, '.cache', envCacheSegment('staging'), dirName);

        // dev run populates dev's namespace.
        await manager.executeSteps('twoenv-dev', { ...baseReq, envName: 'dev' });
        const devMeta1 = JSON.parse(await fs.readFile(path.join(devDir, 'meta.json'), 'utf-8'));
        // Plant a sentinel under dev. If staging wrongly read/cleared dev's
        // namespace (the pre-012 single-namespace bug), this would vanish.
        const devSentinel = path.join(devDir, 'step-sentinel.json');
        await fs.writeFile(devSentinel, '{"turns":[]}');

        // staging run must land in a SEPARATE dir under the staging segment.
        await manager.executeSteps('twoenv-staging', { ...baseReq, envName: 'staging' });
        const stagingMetaExists = await fs.readFile(path.join(stagingDir, 'meta.json'), 'utf-8').then(() => true, () => false);
        // dev's sentinel is untouched — staging never read or wiped dev's dir.
        const devSentinelSurvived = await fs.readFile(devSentinel, 'utf-8').then(() => true, () => false);
        const devMeta2 = JSON.parse(await fs.readFile(path.join(devDir, 'meta.json'), 'utf-8'));

        await fs.rm(projectRoot, { recursive: true, force: true });

        expect(devDir).not.toBe(stagingDir);                 // two distinct on-disk dirs
        expect(path.basename(devDir)).toBe(path.basename(stagingDir)); // same path-derived segment
        expect(devMeta1.stepsHash).toBeTruthy();             // dev was populated
        expect(stagingMetaExists).toBe(true);                // staging populated its OWN dir
        expect(devSentinelSurvived).toBe(true);              // staging did not touch dev's namespace
        expect(devMeta2.stepsHash).toBe(devMeta1.stepsHash); // dev's namespace unchanged by the staging run
      });

      it('a no-env request lands under the `default` env segment (issue 012)', async () => {
        const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-012-noenv-'));
        await fs.writeFile(path.join(projectRoot, 'aiui.config.json'), '{}');
        const testFilePath = path.join(projectRoot, 'tests', 't.md');

        // envName omitted entirely.
        await manager.executeSteps('noenv', { steps: STEPS, fullSteps: STEPS, testFilePath, cacheEnabled: true });

        const defaultDir = path.join(projectRoot, '.cache', envCacheSegment(undefined), cacheDirName(testFilePath, projectRoot));
        const landedUnderDefault = await fs.readFile(path.join(defaultDir, 'meta.json'), 'utf-8').then(() => true, () => false);
        // And nothing leaked into a phantom non-`default` segment.
        const cacheSegments = await fs.readdir(path.join(projectRoot, '.cache'));

        await fs.rm(projectRoot, { recursive: true, force: true });

        expect(envCacheSegment(undefined)).toBe('default');  // the sentinel is literally `default`
        expect(landedUnderDefault).toBe(true);
        expect(cacheSegments).toEqual(['default']);          // only the default namespace exists
      });

      it('the request envName is not silently dropped — the on-disk env segment is the sanitised request env (issue 012)', async () => {
        const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-012-notdropped-'));
        await fs.writeFile(path.join(projectRoot, 'aiui.config.json'), '{}');
        // A non-trivial env name that the segment helper must sanitise — proves
        // the dir reflects THIS request's env (not a stale/default value, and
        // not the raw unsanitised string).
        const envName = 'QA_East';
        await fs.writeFile(path.join(projectRoot, `.env.${envName}`), '');
        const testFilePath = path.join(projectRoot, 'tests', 't.md');

        await manager.executeSteps('notdropped', { steps: STEPS, fullSteps: STEPS, testFilePath, envName, cacheEnabled: true });

        // Read the env-segment directory the manager actually created.
        const cacheSegments = await fs.readdir(path.join(projectRoot, '.cache'));
        const expectedSegment = envCacheSegment(envName);    // 'qa-east'
        const expectedDir = path.join(projectRoot, '.cache', expectedSegment, cacheDirName(testFilePath, projectRoot));
        const landedUnderEnv = await fs.readFile(path.join(expectedDir, 'meta.json'), 'utf-8').then(() => true, () => false);

        await fs.rm(projectRoot, { recursive: true, force: true });

        expect(expectedSegment).toBe('qa-east');             // sanitised, not the raw 'QA_East'
        expect(cacheSegments).toEqual([expectedSegment]);    // exactly this env's segment on disk
        expect(landedUnderEnv).toBe(true);                   // request env reached the dir
      });
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

  // -------------------------------------------------------------------------
  // getActiveSessionsWithTitles — GET /sessions has no deadline of its own, so
  // every page read it takes must carry one.
  // -------------------------------------------------------------------------
  describe('listing sessions with a wedged page', () => {
    function wedgeSession(id: string, opts: { title?: boolean; targetId?: boolean } = {}) {
      const never = () => new Promise(() => {});
      (manager as any).sessions.set(id, {
        id,
        status: 'active',
        totalStepsExecuted: 0,
        sessionConfig: {},
        browserSession: {
          pageTracker: {
            getActive: () => ({
              url: () => 'https://slow.test',
              title: opts.title ? never : async () => 'Fine',
            }),
            activeTabRef: opts.targetId ? never : async () => ({ targetId: 'T', url: 'https://slow.test' }),
          },
        },
        browserTracker: { all: () => [] },
      });
    }

    it('does not hang on a page whose title never resolves', async () => {
      // `page.title()` carries no timeout of its own — the runner races it for
      // exactly this reason. Unbounded here, any non-MCP caller (TestBench,
      // flick, curl) waits forever.
      wedgeSession('mcp:wedged', { title: true });

      const listed = await manager.getActiveSessionsWithTitles();

      expect(listed).toHaveLength(1);
      expect(listed[0]!.pageTitle).toBe('');
      // The row is still useful — the url came from a sync call.
      expect(listed[0]!.currentUrl).toBe('https://slow.test');
    });

    it('does not hang on a target-id lookup that never resolves', async () => {
      wedgeSession('mcp:wedged', { targetId: true });

      const listed = await manager.getActiveSessionsWithTitles();

      expect(listed[0]!.tab).toBeNull();
      expect(listed[0]!.pageTitle).toBe('Fine');
    });

    it('does not let per-session budgets SUM across sessions', async () => {
      // The reason this is parallel. Sequentially, three wedged sessions cost
      // 3x the per-session budget and blew past list_sessions' own 5s abort —
      // so the agent was told the listing timed out instead of getting it.
      // Three sessions on one CDP browser is the arrangement this feature
      // actively encourages.
      wedgeSession('mcp:a', { title: true });
      wedgeSession('mcp:b', { title: true });
      wedgeSession('mcp:c', { title: true });

      const started = Date.now();
      const listed = await manager.getActiveSessionsWithTitles();
      const elapsed = Date.now() - started;

      expect(listed).toHaveLength(3);
      // One budget's worth, not three. Generous bound so this is not a
      // timing-flaky test; the sequential version took ~4.5s here.
      expect(elapsed).toBeLessThan(3_000);
    });
  });

  // -------------------------------------------------------------------------
  // sessionsByTarget (stories/cdp-tabs.md §1) — the tab → session join.
  //
  // The middle link of the close guard: `PageTracker` is tested in
  // browser-manager-cdp and the refusal in cdp-registry, but nothing held this
  // aggregation in place, which is where a defect (enumerating only the active
  // browser) hid through two review rounds.
  // -------------------------------------------------------------------------
  describe('sessionsByTarget', () => {
    /** Inject a session straight into the manager's map — the shapes the join
     *  actually reads, without driving a whole run to produce them. */
    function addSession(
      id: string,
      opts: {
        port?: number | string;
        browsers: { ids: string[]; complete?: boolean }[];
        status?: string;
      },
    ) {
      const browsers = opts.browsers.map((b) => ({
        pageTracker: {
          resolvedTargetIds: async () => ({ ids: b.ids, complete: b.complete ?? true }),
        },
      }));
      (manager as any).sessions.set(id, {
        id,
        status: opts.status ?? 'active',
        sessionConfig: opts.port === undefined ? {} : { cdp: { port: opts.port } },
        browserSession: browsers[0],
        browserTracker: { all: () => browsers },
      });
    }

    it('maps every tab of every browser a session tracks', async () => {
      // Two browsers on one session: the CDP one it attached to, and a
      // launch-mode one `openBrowser` promoted to active. Reading only the
      // ACTIVE one is the defect this pins.
      addSession('mcp:a', { port: 51000, browsers: [{ ids: ['CDPTAB'] }, { ids: ['LAUNCHTAB'] }] });

      const { byTarget, complete } = await manager.sessionsByTarget(51000);
      expect(byTarget.get('CDPTAB')).toBe('mcp:a');
      expect(byTarget.get('LAUNCHTAB')).toBe('mcp:a');
      expect(complete).toBe(true);
    });

    it('ignores sessions on another port, closed sessions, and non-CDP ones', async () => {
      addSession('mcp:other-port', { port: 51001, browsers: [{ ids: ['X'] }] });
      addSession('mcp:closed', { port: 51000, browsers: [{ ids: ['Y'] }], status: 'closed' });
      addSession('mcp:launch-only', { browsers: [{ ids: ['Z'] }] });

      const { byTarget, complete } = await manager.sessionsByTarget(51000);
      expect(byTarget.size).toBe(0);
      // None of them were even consulted, so the answer is a confident "nobody".
      expect(complete).toBe(true);
    });

    it('reports incomplete when a session cannot enumerate its tabs in time', async () => {
      // The load-bearing one: this is what makes the close guard refuse rather
      // than conclude nobody holds the tab.
      addSession('mcp:slow', { port: 51000, browsers: [{ ids: ['A'], complete: false }] });

      const { byTarget, complete } = await manager.sessionsByTarget(51000);
      expect(byTarget.get('A')).toBe('mcp:slow');
      expect(complete).toBe(false);
    });

    it('reports incomplete when a session throws rather than pretending nobody holds it', async () => {
      (manager as any).sessions.set('mcp:broken', {
        id: 'mcp:broken',
        status: 'active',
        sessionConfig: { cdp: { port: 51000 } },
        browserTracker: {
          all: () => [{ pageTracker: { resolvedTargetIds: async () => { throw new Error('boom'); } } }],
        },
      });

      expect((await manager.sessionsByTarget(51000)).complete).toBe(false);
    });

    it('matches a port sent as a string, since the server does not validate it', async () => {
      // `POST /sessions` casts `body.config` unchecked, so a hand-rolled client
      // can create a working CDP session with a string port. A strict compare
      // would skip it — and skipping fails this guard open.
      addSession('mcp:stringy', { port: '51000', browsers: [{ ids: ['S'] }] });

      expect((await manager.sessionsByTarget(51000)).byTarget.get('S')).toBe('mcp:stringy');
    });

    it('names one session when two hold the same tab', async () => {
      addSession('mcp:one', { port: 51000, browsers: [{ ids: ['SHARED'] }] });
      addSession('mcp:two', { port: 51000, browsers: [{ ids: ['SHARED'] }] });

      const { byTarget } = await manager.sessionsByTarget(51000);
      expect(['mcp:one', 'mcp:two']).toContain(byTarget.get('SHARED'));
    });
  });
});
