/**
 * The clarification prompt and the REPL behind it, when the terminal's input
 * ends and when the test's timeout is a real deadline (steptix/steptix#47).
 *
 * The readers here are the real `createLineReader` on streams the test owns,
 * or scripted ones that record what they were asked with — nothing reads the
 * developer's stdin.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { runInteractiveRepl, REPL_INPUT_ENDED } from '../src/runner/interactive-repl.js';
import type { InteractiveReader } from '../src/runner/interactive-repl.js';
import { promptUserWithReplEscape } from '../src/runner/step-executor.js';
import type { StepExecutorOptions } from '../src/runner/step-executor.js';
import type { StepResult } from '../src/report/types.js';
import { createLineReader } from '../src/utils/ask-user.js';

function stubPage(): { url: () => string } {
  return { url: () => 'https://example.com/page' };
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

/** A terminal whose output nobody reads. */
function terminal(): { input: PassThrough; output: PassThrough } {
  const output = new PassThrough();
  output.resume();
  return { input: new PassThrough(), output };
}

function repl(reader: InteractiveReader, writes: string[], entryReason: 'planned' | 'failure' = 'failure') {
  return runInteractiveRepl({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page: stubPage() as any,
    testSteps: ['a', 'b', 'c'],
    currentStepIndex: 2,
    entryReason,
    executorOptions: stubExecutorOptions(),
    adHocResults: [],
    reader,
    write: (s) => writes.push(s),
  });
}

describe('the REPL when its input ends', () => {
  it('leaves as /exit, and says so', async () => {
    const t = terminal();
    t.input.end();
    const reader = createLineReader(t);
    const writes: string[] = [];
    try {
      const decision = await repl(reader, writes);
      expect(decision).toEqual({ kind: 'exit' });
      expect(writes).toContain(REPL_INPUT_ENDED);
    } finally {
      reader.close();
    }
  });

  it('leaves as /exit from the resume menu too', async () => {
    const t = terminal();
    const reader = createLineReader(t);
    const writes: string[] = [];
    try {
      const deciding = repl(reader, writes, 'planned');
      t.input.write('/resume\n');
      t.input.end();
      await expect(deciding).resolves.toEqual({ kind: 'exit' });
      // It got as far as the menu before the input ended.
      expect(writes).toContain('Steps in this test:');
      expect(writes).toContain(REPL_INPUT_ENDED);
    } finally {
      reader.close();
    }
  });
});

describe('promptUserWithReplEscape under a deadline', () => {
  it("asks its question under the step's signal, so a Stop or the timeout ends the wait", async () => {
    const signal = new AbortController().signal;
    const asked: Array<{ prompt: string; signal: AbortSignal | undefined }> = [];
    const reader: InteractiveReader = {
      question: async (prompt, options) => {
        asked.push({ prompt, signal: options?.signal });
        return 'the footer one';
      },
      close: () => {},
    };

    const outcome = await promptUserWithReplEscape({
      question: 'Which one?',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a'],
      currentStepIndex: 1,
      executorOptions: stubExecutorOptions({ signal }),
      adHocResults: [],
      reader,
      write: () => {},
    });

    expect(outcome).toEqual({ kind: 'answer', text: 'the footer one' });
    expect(asked).toEqual([{ prompt: '  Your answer: ', signal }]);
  });

  it('an aborted signal ends an unanswered question with an AbortError', async () => {
    const t = terminal();
    const reader = createLineReader(t);
    const stop = new AbortController();
    try {
      const answering = promptUserWithReplEscape({
        question: 'Which one?',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        page: stubPage() as any,
        testSteps: ['a'],
        currentStepIndex: 1,
        executorOptions: stubExecutorOptions({ signal: stop.signal }),
        adHocResults: [],
        reader,
        write: () => {},
      });
      stop.abort();
      await expect(answering).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      reader.close();
    }
  });

  it('runs the /repl session with the test timeout paused, and only that', async () => {
    let paused = false;
    const pausedPrompts: string[] = [];
    const pauseTestTimeout = vi.fn(async <T,>(wait: () => Promise<T>): Promise<T> => {
      paused = true;
      try {
        return await wait();
      } finally {
        paused = false;
      }
    });
    const lines = ['/repl', '/continue'];
    const reader: InteractiveReader = {
      question: async (prompt) => {
        pausedPrompts.push(`${paused ? 'paused' : 'running'}: ${prompt.trim()}`);
        return lines.shift() ?? '';
      },
      close: () => {},
    };
    const adHocResults: StepResult[] = [];

    const outcome = await promptUserWithReplEscape({
      question: 'Which one?',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: stubPage() as any,
      testSteps: ['a'],
      currentStepIndex: 1,
      executorOptions: stubExecutorOptions({ pauseTestTimeout }),
      adHocResults,
      reader,
      write: () => {},
    });

    // `/continue` from the REPL answers with nothing, as it always has.
    expect(outcome).toEqual({ kind: 'answer', text: '' });
    expect(pauseTestTimeout).toHaveBeenCalledTimes(1);
    // The plain answer is on the clock; the person's session is not.
    expect(pausedPrompts).toEqual(['running: Your answer:', 'paused: >']);
  });
});
