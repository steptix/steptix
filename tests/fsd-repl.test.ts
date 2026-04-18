/**
 * Tests for the Full Self Driving (Supervised) REPL and env parsing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseBoolEnv } from '../src/env/loader.js';
import { runFsdRepl } from '../src/runner/fsd-repl.js';
import type { FsdLineReader } from '../src/runner/fsd-repl.js';
import type { StepResult } from '../src/report/types.js';
import type { StepExecutorOptions } from '../src/runner/step-executor.js';

// ─── Mock the step executor so REPL tests don't hit Playwright ──────────────
const executeStepMock = vi.fn();
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => executeStepMock(...args),
}));

// Mock screenshot capture — REPL uses it for :screenshot
const captureScreenshotMock = vi.fn();
vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: (...args: unknown[]) => captureScreenshotMock(...args),
}));

describe('parseBoolEnv', () => {
  it.each(['true', 'TRUE', '1', 'yes', 'Yes', 'on', 'ON'])('treats %s as true', (value) => {
    expect(parseBoolEnv(value)).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'No', 'off', 'OFF'])('treats %s as false', (value) => {
    expect(parseBoolEnv(value)).toBe(false);
  });

  it('returns undefined for unset or unparseable values', () => {
    expect(parseBoolEnv(undefined)).toBeUndefined();
    expect(parseBoolEnv('')).toBeUndefined();
    expect(parseBoolEnv('maybe')).toBeUndefined();
    expect(parseBoolEnv('2')).toBeUndefined();
  });
});

// ─── FSD REPL ───────────────────────────────────────────────────────────────

/** Build a scripted line reader — each call to question() returns the next line. */
function scriptedReader(lines: string[]): FsdLineReader & { remaining: () => number } {
  let idx = 0;
  return {
    question: async (_prompt: string) => {
      if (idx >= lines.length) {
        throw new Error(`scriptedReader exhausted at prompt: ${_prompt}`);
      }
      return lines[idx++] ?? '';
    },
    close: () => {},
    remaining: () => lines.length - idx,
  };
}

/** Minimal page stub — REPL only reads url() and passes page to executeStep. */
function stubPage(url = 'https://example.com/page'): { url: () => string } {
  return { url: () => url };
}

/** Build the minimum StepExecutorOptions shape the REPL needs. */
function stubExecutorOptions(overrides: Partial<StepExecutorOptions> = {}): StepExecutorOptions {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page: stubPage() as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: { browser: { fullPageScreenshots: false } } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    aiClient: {} as any,
    contextContent: '',
    testName: 'test',
    conversationHistory: [],
    csrfTokens: {},
    ...overrides,
  };
}

describe('runFsdRepl', () => {
  beforeEach(() => {
    executeStepMock.mockReset();
    captureScreenshotMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(':exit returns exit decision', async () => {
    const reader = scriptedReader([':exit']);
    const adHocResults: StepResult[] = [];
    const decision = await runFsdRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['go to /home', 'click Login', 'assert dashboard'],
      failedStepIndex: 2,
      executorOptions: stubExecutorOptions(),
      adHocResults,
      reader,
    });
    expect(decision).toEqual({ kind: 'exit' });
    expect(adHocResults).toHaveLength(0);
  });

  it(':quit is an alias for :exit', async () => {
    const reader = scriptedReader([':quit']);
    const decision = await runFsdRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['step one'],
      failedStepIndex: 1,
      executorOptions: stubExecutorOptions(),
      adHocResults: [],
      reader,
    });
    expect(decision).toEqual({ kind: 'exit' });
  });

  it(':resume with blank input defaults to failedStepIndex + 1', async () => {
    const reader = scriptedReader([':resume', '']);
    const decision = await runFsdRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a', 'b', 'c', 'd'],
      failedStepIndex: 2,
      executorOptions: stubExecutorOptions(),
      adHocResults: [],
      reader,
    });
    expect(decision).toEqual({ kind: 'resume', fromStepIndex: 3 });
  });

  it(':resume with a numeric choice returns that index', async () => {
    const reader = scriptedReader([':resume', '1']);
    const decision = await runFsdRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a', 'b', 'c'],
      failedStepIndex: 2,
      executorOptions: stubExecutorOptions(),
      adHocResults: [],
      reader,
    });
    expect(decision).toEqual({ kind: 'resume', fromStepIndex: 1 });
  });

  it(':resume caps default at the last step when failure is the last one', async () => {
    const reader = scriptedReader([':resume', '']);
    const decision = await runFsdRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a', 'b', 'c'],
      failedStepIndex: 3,
      executorOptions: stubExecutorOptions(),
      adHocResults: [],
      reader,
    });
    expect(decision).toEqual({ kind: 'resume', fromStepIndex: 3 });
  });

  it(':resume with x cancels back to REPL', async () => {
    const reader = scriptedReader([':resume', 'x', ':exit']);
    const decision = await runFsdRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a', 'b'],
      failedStepIndex: 1,
      executorOptions: stubExecutorOptions(),
      adHocResults: [],
      reader,
    });
    expect(decision).toEqual({ kind: 'exit' });
  });

  it(':resume re-prompts on invalid numeric input', async () => {
    const reader = scriptedReader([':resume', '99', '2']);
    const decision = await runFsdRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a', 'b', 'c'],
      failedStepIndex: 1,
      executorOptions: stubExecutorOptions(),
      adHocResults: [],
      reader,
    });
    expect(decision).toEqual({ kind: 'resume', fromStepIndex: 2 });
  });

  it('ad-hoc Flick step is routed to executeStep and appended to results', async () => {
    executeStepMock.mockResolvedValueOnce({
      index: 4,
      instruction: 'click the Save button',
      status: 'passed',
      turns: [],
      durationMs: 10,
      retried: false,
    });
    const reader = scriptedReader(['click the Save button', ':exit']);
    const adHocResults: StepResult[] = [];
    const decision = await runFsdRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a', 'b', 'c'],
      failedStepIndex: 2,
      executorOptions: stubExecutorOptions(),
      adHocResults,
      reader,
    });
    expect(decision).toEqual({ kind: 'exit' });
    expect(executeStepMock).toHaveBeenCalledTimes(1);
    expect(executeStepMock).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      'click the Save button',
      expect.any(Object),
    );
    expect(adHocResults).toHaveLength(1);
    expect(adHocResults[0]!.fsdAdHoc).toBe(true);
  });

  it('failed ad-hoc step does NOT re-trigger handoff; REPL continues', async () => {
    executeStepMock.mockResolvedValueOnce({
      index: 4,
      instruction: 'typo step',
      status: 'failed',
      turns: [],
      durationMs: 5,
      retried: true,
      error: 'selector not found',
    });
    const reader = scriptedReader(['typo step', ':exit']);
    const adHocResults: StepResult[] = [];
    const decision = await runFsdRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a', 'b', 'c'],
      failedStepIndex: 2,
      executorOptions: stubExecutorOptions(),
      adHocResults,
      reader,
    });
    expect(decision).toEqual({ kind: 'exit' });
    expect(adHocResults).toHaveLength(1);
    expect(adHocResults[0]!.status).toBe('failed');
    expect(adHocResults[0]!.fsdAdHoc).toBe(true);
    // Reader should have been fully consumed — no extra prompts
    expect(reader.remaining()).toBe(0);
  });

  it(':screenshot captures and appends a synthetic step', async () => {
    captureScreenshotMock.mockResolvedValueOnce({ base64: 'iVBORw0KG', width: 100, height: 100 });
    const reader = scriptedReader([':screenshot', ':exit']);
    const adHocResults: StepResult[] = [];
    await runFsdRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage('https://example.com/checkout') as any,
      testSteps: ['a', 'b'],
      failedStepIndex: 1,
      executorOptions: stubExecutorOptions(),
      adHocResults,
      reader,
    });
    expect(adHocResults).toHaveLength(1);
    expect(adHocResults[0]!.instruction).toBe('[fsd: screenshot]');
    expect(adHocResults[0]!.fsdAdHoc).toBe(true);
    expect(adHocResults[0]!.screenshotBase64).toBe('iVBORw0KG');
    expect(adHocResults[0]!.pageUrl).toBe('https://example.com/checkout');
    expect(adHocResults[0]!.status).toBe('passed');
  });

  it(':help and unknown commands do not advance or terminate the REPL', async () => {
    const reader = scriptedReader([':help', ':bogus', ':exit']);
    const decision = await runFsdRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a'],
      failedStepIndex: 1,
      executorOptions: stubExecutorOptions(),
      adHocResults: [],
      reader,
    });
    expect(decision).toEqual({ kind: 'exit' });
  });

  it('blank input is a no-op', async () => {
    const reader = scriptedReader(['', '  ', ':exit']);
    const decision = await runFsdRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a'],
      failedStepIndex: 1,
      executorOptions: stubExecutorOptions(),
      adHocResults: [],
      reader,
    });
    expect(decision).toEqual({ kind: 'exit' });
    expect(executeStepMock).not.toHaveBeenCalled();
  });

  it('ad-hoc steps receive monotonically increasing synthetic indices past the test length', async () => {
    executeStepMock.mockResolvedValue({
      index: 0,
      instruction: 'x',
      status: 'passed',
      turns: [],
      durationMs: 1,
      retried: false,
    });
    const reader = scriptedReader(['step one', 'step two', ':exit']);
    await runFsdRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a', 'b', 'c'],
      failedStepIndex: 2,
      executorOptions: stubExecutorOptions(),
      adHocResults: [],
      reader,
    });
    const firstCallIndex = executeStepMock.mock.calls[0]![0] as number;
    const secondCallIndex = executeStepMock.mock.calls[1]![0] as number;
    expect(firstCallIndex).toBeGreaterThan(3);
    expect(secondCallIndex).toBe(firstCallIndex + 1);
  });
});
