/**
 * Tests for the unified interactive REPL — drives both the planned
 * `[interactive]` step entry and the post-failure FSD handoff entry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runInteractiveRepl } from '../src/runner/interactive-repl.js';
import type { InteractiveReader } from '../src/runner/interactive-repl.js';
// runInteractiveRepl is also imported and used directly in the clarification-banner tests below.
import type { StepResult } from '../src/report/types.js';
import type { StepExecutorOptions } from '../src/runner/step-executor.js';

// ─── Mocks ─────────────────────────────────────────────────────────────────
const executeStepMock = vi.fn();
vi.mock('../src/runner/step-executor.js', () => ({
  executeStep: (...args: unknown[]) => executeStepMock(...args),
}));

const captureScreenshotMock = vi.fn();
vi.mock('../src/browser/screenshot.js', () => ({
  captureScreenshot: (...args: unknown[]) => captureScreenshotMock(...args),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Scripted reader; each question() call returns the next line. */
function scriptedReader(lines: string[]): InteractiveReader & { remaining: () => number } {
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

function stubPage(url = 'https://example.com/page'): { url: () => string } {
  return { url: () => url };
}

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

interface ReplCaptured {
  decision: Awaited<ReturnType<typeof runInteractiveRepl>>;
  writes: string[];
  adHocResults: StepResult[];
}

async function runRepl(options: {
  lines: string[];
  entryReason: 'planned' | 'failure';
  currentStepIndex: number;
  testSteps?: string[];
  hint?: string;
  url?: string;
}): Promise<ReplCaptured> {
  const writes: string[] = [];
  const adHocResults: StepResult[] = [];
  const reader = scriptedReader(options.lines);
  const decision = await runInteractiveRepl({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page: stubPage(options.url) as any,
    testSteps: options.testSteps ?? ['a', 'b', 'c'],
    currentStepIndex: options.currentStepIndex,
    entryReason: options.entryReason,
    ...(options.hint !== undefined && { hint: options.hint }),
    executorOptions: stubExecutorOptions(),
    adHocResults,
    reader,
    write: (s) => writes.push(s),
  });
  return { decision, writes, adHocResults };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runInteractiveRepl — exit / quit', () => {
  beforeEach(() => {
    executeStepMock.mockReset();
    captureScreenshotMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('/exit returns exit decision', async () => {
    const { decision, adHocResults } = await runRepl({
      lines: ['/exit'],
      entryReason: 'failure',
      currentStepIndex: 2,
    });
    expect(decision).toEqual({ kind: 'exit' });
    expect(adHocResults).toHaveLength(0);
  });

  it('/quit is an alias for /exit', async () => {
    const { decision } = await runRepl({
      lines: ['/quit'],
      entryReason: 'failure',
      currentStepIndex: 1,
    });
    expect(decision).toEqual({ kind: 'exit' });
  });

  it('/exit works in planned-entry mode too', async () => {
    const { decision } = await runRepl({
      lines: ['/exit'],
      entryReason: 'planned',
      currentStepIndex: 1,
    });
    expect(decision).toEqual({ kind: 'exit' });
  });
});

describe('runInteractiveRepl — continue', () => {
  beforeEach(() => executeStepMock.mockReset());

  it('/continue returns continue decision (planned entry)', async () => {
    const { decision } = await runRepl({
      lines: ['/continue'],
      entryReason: 'planned',
      currentStepIndex: 2,
    });
    expect(decision).toEqual({ kind: 'continue' });
  });

  it('/continue returns continue decision (failure entry)', async () => {
    const { decision } = await runRepl({
      lines: ['/continue'],
      entryReason: 'failure',
      currentStepIndex: 2,
    });
    expect(decision).toEqual({ kind: 'continue' });
  });
});

describe('runInteractiveRepl — resume', () => {
  beforeEach(() => executeStepMock.mockReset());

  it('/resume with blank input defaults to currentStepIndex + 1', async () => {
    const { decision } = await runRepl({
      lines: ['/resume', ''],
      entryReason: 'failure',
      currentStepIndex: 2,
      testSteps: ['a', 'b', 'c', 'd'],
    });
    expect(decision).toEqual({ kind: 'resume', fromStepIndex: 3 });
  });

  it('/resume default in planned entry is also currentStepIndex + 1', async () => {
    const { decision } = await runRepl({
      lines: ['/resume', ''],
      entryReason: 'planned',
      currentStepIndex: 2,
      testSteps: ['a', '[interactive]', 'c', 'd'],
    });
    expect(decision).toEqual({ kind: 'resume', fromStepIndex: 3 });
  });

  it('/resume with a numeric choice returns that index', async () => {
    const { decision } = await runRepl({
      lines: ['/resume', '1'],
      entryReason: 'failure',
      currentStepIndex: 2,
    });
    expect(decision).toEqual({ kind: 'resume', fromStepIndex: 1 });
  });

  it('/resume caps default at the last step when current is the last one', async () => {
    const { decision } = await runRepl({
      lines: ['/resume', ''],
      entryReason: 'failure',
      currentStepIndex: 3,
    });
    expect(decision).toEqual({ kind: 'resume', fromStepIndex: 3 });
  });

  it('/resume with x cancels back to REPL', async () => {
    const { decision } = await runRepl({
      lines: ['/resume', 'x', '/exit'],
      entryReason: 'failure',
      currentStepIndex: 1,
    });
    expect(decision).toEqual({ kind: 'exit' });
  });

  it('/resume re-prompts on invalid numeric input', async () => {
    const { decision } = await runRepl({
      lines: ['/resume', '99', '2'],
      entryReason: 'failure',
      currentStepIndex: 1,
    });
    expect(decision).toEqual({ kind: 'resume', fromStepIndex: 2 });
  });
});

describe('runInteractiveRepl — ad-hoc Flick steps', () => {
  beforeEach(() => executeStepMock.mockReset());

  it('routes plain text to executeStep and tags result with interactiveAdHoc', async () => {
    executeStepMock.mockResolvedValueOnce({
      index: 4,
      instruction: 'click the Save button',
      status: 'passed',
      turns: [],
      durationMs: 10,
      retried: false,
    });
    const { decision, adHocResults } = await runRepl({
      lines: ['click the Save button', '/exit'],
      entryReason: 'failure',
      currentStepIndex: 2,
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
    expect(adHocResults[0]!.interactiveAdHoc).toBe(true);
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
    const reader = scriptedReader(['typo step', '/exit']);
    const adHocResults: StepResult[] = [];
    await runInteractiveRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a', 'b', 'c'],
      currentStepIndex: 2,
      entryReason: 'failure',
      executorOptions: stubExecutorOptions(),
      adHocResults,
      reader,
      write: () => {},
    });
    expect(adHocResults).toHaveLength(1);
    expect(adHocResults[0]!.status).toBe('failed');
    expect(adHocResults[0]!.interactiveAdHoc).toBe(true);
    expect(reader.remaining()).toBe(0);
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
    await runRepl({
      lines: ['step one', 'step two', '/exit'],
      entryReason: 'failure',
      currentStepIndex: 2,
      testSteps: ['a', 'b', 'c'],
    });
    const firstIdx = executeStepMock.mock.calls[0]![0] as number;
    const secondIdx = executeStepMock.mock.calls[1]![0] as number;
    expect(firstIdx).toBeGreaterThan(3);
    expect(secondIdx).toBe(firstIdx + 1);
  });

  it('input whose first token looks like a path (e.g. "/admin/users …") is treated as a Flick step, not an unknown command', async () => {
    executeStepMock.mockResolvedValueOnce({
      index: 5,
      instruction: '/admin/users page should load',
      status: 'passed',
      turns: [],
      durationMs: 1,
      retried: false,
    });
    const { writes } = await runRepl({
      lines: ['/admin/users page should load', '/exit'],
      entryReason: 'failure',
      currentStepIndex: 1,
      testSteps: ['a'],
    });
    expect(executeStepMock).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      '/admin/users page should load',
      expect.any(Object),
    );
    expect(writes.some((w) => /unknown command/i.test(w))).toBe(false);
  });
});

describe('runInteractiveRepl — /screenshot', () => {
  beforeEach(() => captureScreenshotMock.mockReset());

  it('captures and appends a synthetic step', async () => {
    captureScreenshotMock.mockResolvedValueOnce({ base64: 'iVBORw0KG', width: 100, height: 100 });
    const { adHocResults } = await runRepl({
      lines: ['/screenshot', '/exit'],
      entryReason: 'failure',
      currentStepIndex: 1,
      testSteps: ['a', 'b'],
      url: 'https://example.com/checkout',
    });
    expect(adHocResults).toHaveLength(1);
    expect(adHocResults[0]!.instruction).toBe('[interactive: screenshot]');
    expect(adHocResults[0]!.interactiveAdHoc).toBe(true);
    expect(adHocResults[0]!.screenshotBase64).toBe('iVBORw0KG');
    expect(adHocResults[0]!.pageUrl).toBe('https://example.com/checkout');
    expect(adHocResults[0]!.status).toBe('passed');
  });
});

describe('runInteractiveRepl — /help, blank input, banners, deprecation hints', () => {
  beforeEach(() => executeStepMock.mockReset());

  it('/help and unknown slash commands do not advance or terminate the REPL', async () => {
    const { decision, writes } = await runRepl({
      lines: ['/help', '/bogus', '/exit'],
      entryReason: 'failure',
      currentStepIndex: 1,
      testSteps: ['a'],
    });
    expect(decision).toEqual({ kind: 'exit' });
    expect(writes.some((w) => /commands/i.test(w))).toBe(true);
    expect(writes.some((w) => /unknown command/i.test(w))).toBe(true);
  });

  it('blank input is a no-op', async () => {
    const { decision } = await runRepl({
      lines: ['', '  ', '/exit'],
      entryReason: 'failure',
      currentStepIndex: 1,
      testSteps: ['a'],
    });
    expect(decision).toEqual({ kind: 'exit' });
    expect(executeStepMock).not.toHaveBeenCalled();
  });

  it('planned-entry banner mentions interactive mode and includes the hint when given', async () => {
    const { writes } = await runRepl({
      lines: ['/exit'],
      entryReason: 'planned',
      currentStepIndex: 2,
      hint: 'explore the page',
    });
    const banner = writes.join('\n');
    expect(banner).toMatch(/interactive/i);
    expect(banner).toContain('explore the page');
  });

  it('failure-entry banner mentions step failure', async () => {
    const { writes } = await runRepl({
      lines: ['/exit'],
      entryReason: 'failure',
      currentStepIndex: 2,
      testSteps: ['a', 'b', 'c'],
    });
    const banner = writes.join('\n');
    expect(banner).toMatch(/failed/i);
  });

  it('clarification-entry banner shows the AI question and the relevant escape commands', async () => {
    // runRepl currently doesn't accept a clarificationQuestion override;
    // call runInteractiveRepl directly so the banner can be inspected.
    const writes: string[] = [];
    const reader = scriptedReader(['/exit']);
    await runInteractiveRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a', 'b', 'c'],
      currentStepIndex: 2,
      entryReason: 'clarification',
      clarificationQuestion: 'Did you mean Save or Save As?',
      executorOptions: stubExecutorOptions(),
      adHocResults: [],
      reader,
      write: (s) => writes.push(s),
    });
    const banner = writes.join('\n');
    expect(banner).toContain('Did you mean Save or Save As?');
    expect(banner).toMatch(/\/help/);
    expect(banner).toMatch(/\/continue/);
    expect(banner).toMatch(/\/resume/);
    expect(banner).toMatch(/\/exit/);
  });

  it('clarification-entry /resume default index is currentStepIndex + 1', async () => {
    const writes: string[] = [];
    const reader = scriptedReader(['/resume', '']);
    const decision = await runInteractiveRepl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a', 'b', 'c', 'd'],
      currentStepIndex: 2,
      entryReason: 'clarification',
      clarificationQuestion: 'Confirm?',
      executorOptions: stubExecutorOptions(),
      adHocResults: [],
      reader,
      write: (s) => writes.push(s),
    });
    expect(decision).toEqual({ kind: 'resume', fromStepIndex: 3 });
  });

  it('typing bare-word "done" prints a deprecation hint and stays in REPL', async () => {
    const { decision, writes } = await runRepl({
      lines: ['done', '/exit'],
      entryReason: 'planned',
      currentStepIndex: 1,
      testSteps: ['a'],
    });
    expect(decision).toEqual({ kind: 'exit' });
    expect(writes.some((w) => /\/continue/.test(w))).toBe(true);
    // It must NOT have been routed as a Flick step.
    expect(executeStepMock).not.toHaveBeenCalled();
  });

  it('typing bare-word "exit" prints a deprecation hint and stays in REPL', async () => {
    const { decision, writes } = await runRepl({
      lines: ['exit', '/exit'],
      entryReason: 'planned',
      currentStepIndex: 1,
      testSteps: ['a'],
    });
    expect(decision).toEqual({ kind: 'exit' });
    expect(writes.some((w) => /\/exit/.test(w))).toBe(true);
    expect(executeStepMock).not.toHaveBeenCalled();
  });

  it('typing the previous-design ":continue" prefix prints a hint pointing at /continue', async () => {
    const { decision, writes } = await runRepl({
      lines: [':continue', '/exit'],
      entryReason: 'planned',
      currentStepIndex: 1,
      testSteps: ['a'],
    });
    expect(decision).toEqual({ kind: 'exit' });
    expect(writes.some((w) => /\/continue/.test(w))).toBe(true);
    expect(executeStepMock).not.toHaveBeenCalled();
  });
});
