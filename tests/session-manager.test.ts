import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('../src/browser/manager.js', () => ({
  launchBrowser: vi.fn(async () => ({ ...mockBrowserSession })),
  closeBrowser: vi.fn(async () => {}),
  PageTracker: vi.fn(),
}));

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
}));

vi.mock('../src/context/loader.js', () => ({
  loadContextFiles: vi.fn(async () => ({ files: [], combined: '' })),
}));

vi.mock('../src/ai/client.js', () => ({
  AiClient: class {
    chat = vi.fn(async () => '{}');
  },
}));

vi.mock('../src/utils/tokens.js', () => ({
  TokenTracker: class {
    resetStep = vi.fn();
    totalTokens = 0;
  },
}));

vi.mock('../src/api/response-store.js', () => ({
  ApiResponseStore: class {
    store = vi.fn();
    getHistory = vi.fn(() => []);
  },
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
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { SessionManager } from '../src/server/session-manager.js';
import { executeStep } from '../src/runner/step-executor.js';
import { closeBrowser } from '../src/browser/manager.js';

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
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager(testConfig);
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

      await manager.closeSession('session-1');

      expect(closeBrowser).toHaveBeenCalled();
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
