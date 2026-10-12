/**
 * Tests for src/utils/ask-user.ts — the one rule every terminal prompt in
 * `steptix run` follows (#46, #47): ask only when stdin is a terminal, and a
 * question whose input ends before an answer rejects instead of hanging.
 *
 * Streams are injected, so nothing here reads the developer's stdin.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { canAskUser, createLineReader, NoAnswerError } from '../src/utils/ask-user.js';

/** An input to type into and an output nobody reads. */
function streams(): { input: PassThrough; output: PassThrough } {
  const output = new PassThrough();
  output.resume();
  return { input: new PassThrough(), output };
}

/**
 * Whether a promise has settled, without awaiting it. Swallows the rejection
 * a `close()` in `finally` gives a question left pending, so nothing is
 * reported as unhandled.
 */
function track(p: Promise<unknown>): () => boolean {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

/** Let the streams and readline deliver what was written — turns, not time. */
async function drain(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('canAskUser', () => {
  it('is true only for a terminal', () => {
    expect(canAskUser({ isTTY: true })).toBe(true);
    expect(canAskUser({ isTTY: false })).toBe(false);
    // A pipe or a file has no isTTY at all.
    expect(canAskUser({})).toBe(false);
  });
});

describe('createLineReader', () => {
  it('answers with the typed line', async () => {
    const s = streams();
    const reader = createLineReader(s);
    try {
      const answer = reader.question('Name: ');
      s.input.write('Ada\n');
      await expect(answer).resolves.toBe('Ada');
    } finally {
      reader.close();
    }
  });

  it('asks several questions in turn', async () => {
    const s = streams();
    const reader = createLineReader(s);
    try {
      const first = reader.question('One: ');
      s.input.write('1\n');
      await expect(first).resolves.toBe('1');
      const second = reader.question('Two: ');
      s.input.write('2\n');
      await expect(second).resolves.toBe('2');
    } finally {
      reader.close();
    }
  });

  // The bug both issues share: a bare `rl.question` stays pending forever
  // once its input ends.
  it('rejects with NoAnswerError when input ends before an answer', async () => {
    const s = streams();
    const reader = createLineReader(s);
    try {
      const answer = reader.question('Password: ');
      s.input.end();
      const err = await answer.then(
        () => {
          throw new Error('expected the question to reject');
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(NoAnswerError);
      expect((err as NoAnswerError).prompt).toBe('Password: ');
      expect((err as Error).message).toContain('Password:');
    } finally {
      reader.close();
    }
  });

  it('rejects a question asked after the input has ended', async () => {
    const s = streams();
    const reader = createLineReader(s);
    try {
      const first = reader.question('One: ');
      s.input.end();
      await expect(first).rejects.toBeInstanceOf(NoAnswerError);
      await expect(reader.question('Two: ')).rejects.toBeInstanceOf(NoAnswerError);
    } finally {
      reader.close();
    }
  });

  it('rejects when the input had already ended before the reader was created', async () => {
    const s = streams();
    s.input.end();
    s.input.resume();
    await new Promise((resolve) => s.input.once('end', resolve));
    const reader = createLineReader(s);
    try {
      await expect(reader.question('Name: ')).rejects.toBeInstanceOf(NoAnswerError);
    } finally {
      reader.close();
    }
  });

  // Ctrl+C at a prompt must stop the run. Settling the question either way —
  // an answer, or "input ended" — would let the caller carry on (fail the
  // step, run the `otherwise continue` tail, open the failure REPL) while the
  // process goes down. So it stays unanswered and the signal is raised.
  it('raises the interrupt on Ctrl+C and leaves the question unanswered', async () => {
    const s = streams();
    let interrupted = 0;
    const reader = createLineReader({ ...s, terminal: true, onInterrupt: () => interrupted++ });
    try {
      const answer = reader.question('Code: ');
      const settled = track(answer);
      s.input.write('\x03');
      await drain();
      expect(interrupted).toBe(1);
      expect(settled()).toBe(false);
      // A line typed while the process goes down answers nothing: not the
      // question that was waiting, nor one asked after the Ctrl+C.
      const later = track(reader.question('Again: '));
      s.input.write('typed anyway\n');
      await drain();
      expect(settled()).toBe(false);
      expect(later()).toBe(false);
    } finally {
      reader.close();
    }
  });

  it('does not report "input ended" when the input ends after a Ctrl+C', async () => {
    const s = streams();
    const reader = createLineReader({ ...s, terminal: true, onInterrupt: () => {} });
    try {
      const settled = track(reader.question('Code: '));
      s.input.write('\x03');
      await drain();
      s.input.end();
      await drain();
      expect(settled()).toBe(false);
    } finally {
      reader.close();
    }
  });

  it("does not let the caller's signal settle a question after a Ctrl+C", async () => {
    const s = streams();
    const reader = createLineReader({ ...s, terminal: true, onInterrupt: () => {} });
    try {
      const deadline = new AbortController();
      const settled = track(reader.question('Your answer: ', { signal: deadline.signal }));
      s.input.write('\x03');
      await drain();
      deadline.abort();
      await drain();
      expect(settled()).toBe(false);
    } finally {
      reader.close();
    }
  });

  // A REPL's reader and the clarification prompt one of its steps opened can
  // both be on stdin. Playwright reads a second raise as "force" and skips
  // the graceful browser close, so one keystroke raises once.
  it('raises once per Ctrl+C when two readers share the input', async () => {
    const s = streams();
    let interrupted = 0;
    const onInterrupt = (): void => {
      interrupted++;
    };
    const outer = createLineReader({ ...s, terminal: true, onInterrupt });
    const inner = createLineReader({ ...s, terminal: true, onInterrupt });
    try {
      track(outer.question('> '));
      track(inner.question('Your answer: '));
      s.input.write('\x03');
      await drain();
      expect(interrupted).toBe(1);
      // A second, separate Ctrl+C is a second raise.
      s.input.write('\x03');
      await drain();
      expect(interrupted).toBe(2);
    } finally {
      inner.close();
      outer.close();
    }
  });

  // The default: run the process's own SIGINT listeners (Playwright's closes
  // its browsers). With one registered, no real signal is sent, so this is
  // safe to run in the test process.
  it("runs the process's SIGINT listeners on Ctrl+C by default", async () => {
    const s = streams();
    let heard = 0;
    const listener = (): void => {
      heard++;
    };
    process.on('SIGINT', listener);
    const reader = createLineReader({ ...s, terminal: true });
    try {
      track(reader.question('Code: '));
      s.input.write('\x03');
      await drain();
      expect(heard).toBe(1);
    } finally {
      reader.close();
      process.off('SIGINT', listener);
    }
  });

  it('treats Ctrl+D at an empty terminal prompt as end of input, not an interrupt', async () => {
    const s = streams();
    let interrupted = 0;
    const reader = createLineReader({ ...s, terminal: true, onInterrupt: () => interrupted++ });
    try {
      const answer = reader.question('Code: ');
      s.input.write('\x04');
      await expect(answer).rejects.toBeInstanceOf(NoAnswerError);
      expect(interrupted).toBe(0);
    } finally {
      reader.close();
    }
  });

  it("rejects with the signal's AbortError, not NoAnswerError, when the caller aborts", async () => {
    const s = streams();
    const reader = createLineReader(s);
    try {
      const controller = new AbortController();
      const answer = reader.question('Name: ', { signal: controller.signal });
      controller.abort();
      const err = await answer.then(
        () => {
          throw new Error('expected the question to reject');
        },
        (e: unknown) => e,
      );
      expect(err).not.toBeInstanceOf(NoAnswerError);
      expect((err as Error).name).toBe('AbortError');
    } finally {
      reader.close();
    }
  });
});
