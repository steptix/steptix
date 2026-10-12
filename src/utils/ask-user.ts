/**
 * Asking the person at the terminal, and knowing when there is nobody to ask.
 *
 * `steptix run` asks at the terminal in four places: a parameter with no value
 * (`Enter value for "password":`), an `[input: …]` step, the AI's
 * clarification question, and the failure REPL. Each awaited `rl.question`
 * on `process.stdin` without checking whether anything could ever answer.
 * When stdin is not a terminal and has already ended — CI, a script, a
 * scheduled job — readline closes and the pending question NEVER settles: no
 * answer, no error. With nothing else holding the event loop, Node then
 * exits 0 and the run looks like a pass (#46); with a browser open, it waits
 * forever, past the test's own `timeout:` (#47).
 *
 * Two rules, so every prompt answers the same way:
 *
 * - {@link canAskUser}: ask only when stdin is a terminal. Otherwise the
 *   caller fails with a message that names what it needed.
 * - {@link createLineReader}: a question whose input ends before an answer
 *   rejects with {@link NoAnswerError} instead of staying pending. That covers
 *   a terminal closed with Ctrl+D, and any reader created anyway. Ctrl+C is
 *   NOT end of input: it stops the run, as it does anywhere else in it.
 */
import readline from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

/**
 * The question was asked, and the input ended before an answer arrived.
 * Carries the prompt so the failure can say what was asked.
 */
export class NoAnswerError extends Error {
  constructor(public readonly prompt: string) {
    super(`No answer to "${prompt.trim()}": input ended before an answer was typed`);
    this.name = 'NoAnswerError';
  }
}

/**
 * Can anyone answer a question typed at the terminal? Only when stdin is a
 * TTY. A pipe, a file or a closed handle may still deliver bytes, but nothing
 * there is reading the prompt — and when it has ended, an unguarded question
 * waits forever.
 */
export function canAskUser(stdin: { isTTY?: boolean } = process.stdin): boolean {
  return Boolean(stdin.isTTY);
}

/** The reader shape the REPL and the clarification prompt already use. */
export interface LineReader {
  /**
   * Rejects with {@link NoAnswerError} if input ends first, and with the
   * signal's `AbortError` if `signal` aborts first — so a caller that already
   * recognises an abort (a stopped run, a test timeout) keeps doing so.
   * After Ctrl+C it does not settle: the process is going down.
   */
  question(prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
  close(): void;
}

export interface LineReaderOptions {
  input?: Readable;
  output?: Writable;
  /** Force readline's terminal mode; by default readline decides from `output`. */
  terminal?: boolean;
  /**
   * What Ctrl+C at a question does. Defaults to re-raising SIGINT on this
   * process. A seam for tests, which must not.
   */
  onInterrupt?: () => void;
}

// One Ctrl+C reaches every reader open on stdin — a REPL's, and the
// clarification prompt one of its typed steps opened — and each would raise.
// Playwright reads a second raise as a second Ctrl+C and kills the browsers
// without the graceful close. The readers hear one keystroke in one
// synchronous dispatch, so a flag cleared on the next microtask spans that
// keystroke. Two presses that arrive in one read collapse into one raise too;
// raw mode is off after it, so the next press is an OS signal and still forces.
let raisingInterrupt = false;

function interruptOnce(raise: () => void): void {
  if (raisingInterrupt) return;
  raisingInterrupt = true;
  queueMicrotask(() => {
    raisingInterrupt = false;
  });
  raise();
}

/**
 * Ctrl+C typed at a raw-mode prompt arrives as a keystroke, not a signal, so
 * the process's own SIGINT listeners never heard it. Run them — Playwright's
 * closes the browsers it launched and exits 130 — and only when there are
 * none fall back to the signal itself. Not `process.kill` first: on Windows
 * that terminates outright, skipping the listeners and orphaning the browser.
 */
function raiseSigint(): void {
  if (process.listenerCount('SIGINT') > 0) process.emit('SIGINT', 'SIGINT');
  else process.kill(process.pid, 'SIGINT');
}

/**
 * A readline interface whose questions settle. One reader can ask several
 * questions in turn (the REPL does); once its input has ended, every pending
 * and later question rejects.
 */
export function createLineReader(opts: LineReaderOptions = {}): LineReader {
  const input = opts.input ?? process.stdin;
  const rl = readline.createInterface({
    input,
    output: opts.output ?? process.stdout,
    ...(opts.terminal !== undefined && { terminal: opts.terminal }),
  });
  let closed = false;
  const onClose = new AbortController();
  rl.once('close', () => {
    closed = true;
    onClose.abort();
  });
  // With no 'SIGINT' listener, readline answers Ctrl+C by closing — which
  // would read as end of input here, fail just this step, and carry the run
  // on to the next one. Someone pressing Ctrl+C at a prompt means stop, the
  // same as Ctrl+C between prompts. So the question is left unanswered — the
  // caller never resumes — and the signal goes to the process as if no prompt
  // were open. Readline's own question is cancelled, so neither a line typed
  // in the meantime, nor end of input, nor the step's signal can settle it
  // (see the catch below). Raw mode goes first, because the process may end
  // without readline's own close(); a second Ctrl+C is then an ordinary
  // signal, which Playwright reads as "force". Not `rl.pause()`: a paused
  // stdin can let the event loop run dry before a SIGINT listener that is
  // still closing things gets to end the process.
  let interrupted = false;
  const interruptCtl = new AbortController();
  rl.on('SIGINT', () => {
    interrupted = true;
    const tty = input as Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
    if (tty.isTTY && typeof tty.setRawMode === 'function') tty.setRawMode(false);
    interruptCtl.abort();
    interruptOnce(opts.onInterrupt ?? raiseSigint);
  });
  // An input that ended before this reader existed never emits 'end' again,
  // so readline never closes and a question would wait forever.
  if (input.readableEnded) rl.close();

  return {
    async question(prompt, options = {}) {
      // Code still running while the process goes down must not get a fresh
      // prompt to read from — nor "input ended", if stdin closed since.
      if (interrupted) return new Promise<string>(() => {});
      if (closed) throw new NoAnswerError(prompt);
      const signal = AbortSignal.any([
        onClose.signal,
        interruptCtl.signal,
        ...(options.signal ? [options.signal] : []),
      ]);
      try {
        return await rl.question(prompt, { signal });
      } catch (err) {
        // Ctrl+C was pressed while this question waited: whatever ended it
        // since, the caller is not to resume.
        if (interrupted) return new Promise<string>(() => {});
        if (closed && (err as Error | undefined)?.name === 'AbortError') {
          throw new NoAnswerError(prompt);
        }
        throw err;
      }
    },
    close() {
      rl.close();
    },
  };
}
