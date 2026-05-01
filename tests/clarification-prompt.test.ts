/**
 * Tests for promptUserWithReplEscape — the AI clarification prompt with the
 * `/repl` escape hatch. We mock `runInteractiveRepl` directly so the wrapper
 * is exercised in isolation (no transitive dependency on executeStep / page).
 *
 * The REPL itself is covered by tests/interactive-repl.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promptUserWithReplEscape } from '../src/runner/step-executor.js';
import type { InteractiveReader } from '../src/runner/interactive-repl.js';
import type { StepResult } from '../src/report/types.js';
import type { StepExecutorOptions } from '../src/runner/step-executor.js';

// Mock runInteractiveRepl so the wrapper's `/repl` branch can be steered
// without invoking the real REPL (which transitively calls executeStep).
const runInteractiveReplMock = vi.fn();
vi.mock('../src/runner/interactive-repl.js', async () => {
  const actual = await vi.importActual<typeof import('../src/runner/interactive-repl.js')>(
    '../src/runner/interactive-repl.js',
  );
  return {
    ...actual,
    runInteractiveRepl: (...args: unknown[]) => runInteractiveReplMock(...args),
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

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

interface RunOptions {
  lines: string[];
  question?: string;
  testSteps?: string[];
  currentStepIndex?: number;
}

async function runWrapper(options: RunOptions): Promise<{
  outcome: Awaited<ReturnType<typeof promptUserWithReplEscape>>;
  writes: string[];
  adHocResults: StepResult[];
}> {
  const writes: string[] = [];
  const adHocResults: StepResult[] = [];
  const reader = scriptedReader(options.lines);
  const outcome = await promptUserWithReplEscape({
    question: options.question ?? 'Which item did you mean?',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page: stubPage() as any,
    testSteps: options.testSteps ?? ['a', 'b', 'c'],
    currentStepIndex: options.currentStepIndex ?? 2,
    executorOptions: stubExecutorOptions(),
    adHocResults,
    reader,
    write: (s) => writes.push(s),
  });
  return { outcome, writes, adHocResults };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('promptUserWithReplEscape — answer path (no REPL entry)', () => {
  beforeEach(() => runInteractiveReplMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('returns plain text as the answer', async () => {
    const { outcome } = await runWrapper({ lines: ['the second one'] });
    expect(outcome).toEqual({ kind: 'answer', text: 'the second one' });
    expect(runInteractiveReplMock).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from the answer', async () => {
    const { outcome } = await runWrapper({ lines: ['   yes   '] });
    expect(outcome).toEqual({ kind: 'answer', text: 'yes' });
  });

  it('text starting with "/" (other than /repl) is returned verbatim as the answer', async () => {
    const { outcome } = await runWrapper({ lines: ['/admin/users'] });
    expect(outcome).toEqual({ kind: 'answer', text: '/admin/users' });
    expect(runInteractiveReplMock).not.toHaveBeenCalled();
  });

  it('text starting with "/exit" is returned as the answer (the prompt itself recognises only /repl)', async () => {
    const { outcome } = await runWrapper({ lines: ['/exit'] });
    expect(outcome).toEqual({ kind: 'answer', text: '/exit' });
    expect(runInteractiveReplMock).not.toHaveBeenCalled();
  });

  it('text starting with "/continue" is returned as the answer (only /repl is recognised)', async () => {
    const { outcome } = await runWrapper({ lines: ['/continue'] });
    expect(outcome).toEqual({ kind: 'answer', text: '/continue' });
    expect(runInteractiveReplMock).not.toHaveBeenCalled();
  });

  it('shows the AI question in the prompt banner', async () => {
    const { writes } = await runWrapper({
      lines: ['ok'],
      question: 'Did you mean Save or Save As?',
    });
    expect(writes.some((w) => w.includes('Did you mean Save or Save As?'))).toBe(true);
  });

  it('mentions /repl in the prompt banner', async () => {
    const { writes } = await runWrapper({ lines: ['ok'] });
    expect(writes.some((w) => /\/repl/.test(w))).toBe(true);
  });
});

describe('promptUserWithReplEscape — /repl escape hatch', () => {
  beforeEach(() => runInteractiveReplMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('/repl invokes runInteractiveRepl with entryReason=clarification + the question + currentStepIndex', async () => {
    runInteractiveReplMock.mockResolvedValueOnce({ kind: 'continue' });
    await runWrapper({
      lines: ['/repl'],
      question: 'Confirm action?',
      currentStepIndex: 5,
      testSteps: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(runInteractiveReplMock).toHaveBeenCalledTimes(1);
    const args = runInteractiveReplMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.entryReason).toBe('clarification');
    expect(args.clarificationQuestion).toBe('Confirm action?');
    expect(args.currentStepIndex).toBe(5);
    expect(args.testSteps).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('REPL.continue → outcome { kind: "answer", text: "" }', async () => {
    runInteractiveReplMock.mockResolvedValueOnce({ kind: 'continue' });
    const { outcome } = await runWrapper({ lines: ['/repl'] });
    expect(outcome).toEqual({ kind: 'answer', text: '' });
  });

  it('REPL.exit → outcome { kind: "exit" }', async () => {
    runInteractiveReplMock.mockResolvedValueOnce({ kind: 'exit' });
    const { outcome } = await runWrapper({ lines: ['/repl'] });
    expect(outcome).toEqual({ kind: 'exit' });
  });

  it('REPL.resume → outcome { kind: "resume", fromStepIndex }', async () => {
    runInteractiveReplMock.mockResolvedValueOnce({ kind: 'resume', fromStepIndex: 7 });
    const { outcome } = await runWrapper({ lines: ['/repl'] });
    expect(outcome).toEqual({ kind: 'resume', fromStepIndex: 7 });
  });

  it('/repl is case-insensitive', async () => {
    runInteractiveReplMock.mockResolvedValueOnce({ kind: 'exit' });
    const { outcome } = await runWrapper({ lines: ['/REPL'] });
    expect(outcome).toEqual({ kind: 'exit' });
    expect(runInteractiveReplMock).toHaveBeenCalledTimes(1);
  });

  it('whitespace around /repl is tolerated', async () => {
    runInteractiveReplMock.mockResolvedValueOnce({ kind: 'exit' });
    const { outcome } = await runWrapper({ lines: ['  /repl  '] });
    expect(outcome).toEqual({ kind: 'exit' });
  });

  it('"/repl extra text" is NOT treated as the /repl command (only exact /repl after trim)', async () => {
    const { outcome } = await runWrapper({ lines: ['/repl please'] });
    expect(outcome).toEqual({ kind: 'answer', text: '/repl please' });
    expect(runInteractiveReplMock).not.toHaveBeenCalled();
  });

  it('reader passed into the wrapper is forwarded to runInteractiveRepl so a single readline is shared', async () => {
    runInteractiveReplMock.mockResolvedValueOnce({ kind: 'exit' });
    await runWrapper({ lines: ['/repl'] });
    const args = runInteractiveReplMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.reader).toBeDefined();
  });

  it('adHocResults accumulator is forwarded to runInteractiveRepl so REPL captures land in the caller array', async () => {
    runInteractiveReplMock.mockImplementationOnce(async (ctx: { adHocResults: StepResult[] }) => {
      ctx.adHocResults.push({
        index: 99,
        instruction: 'click Save',
        status: 'passed',
        turns: [],
        durationMs: 1,
        retried: false,
        interactiveAdHoc: true,
      });
      return { kind: 'continue' };
    });
    const { outcome, adHocResults } = await runWrapper({ lines: ['/repl'] });
    expect(outcome).toEqual({ kind: 'answer', text: '' });
    expect(adHocResults).toHaveLength(1);
    expect(adHocResults[0]!.instruction).toBe('click Save');
    expect(adHocResults[0]!.interactiveAdHoc).toBe(true);
  });
});
