/**
 * The test's `timeout:` as a real deadline for `steptix run`
 * (steptix/steptix#47).
 *
 * The budget used to be checked only at the top of the step loop, between
 * steps, so a step that never returned could never time out: an AI question
 * nobody could answer waited 7.6 hours past a 600 s `timeout:`. That check
 * stays — a step whose work ignores its signal still runs to the end before
 * the run notices — and this adds a timer that aborts the step in flight when
 * the budget runs out. It aborts through the signal a Stop already uses
 * (issues/020, issues/022), so every wait that gives way to a Stop gives way
 * to the timeout as well, with no new plumbing in the executors.
 *
 * Why the check was between steps, and what relied on it: the budget is the
 * run's own time, not a person's. An `[input:]` step added its wait back to
 * the deadline, and the REPLs restart it on `/resume`. A timer that ran
 * through an `[input:]` answer would cut the person off mid-word, so
 * {@link TestDeadline.pause} stops it while one is typed and gives the time
 * back after — the same accounting, kept exact instead of settled up at the
 * next step.
 *
 * A timeout and a Stop share the signal but not the outcome.
 * {@link TestDeadline.timedOut} says the budget ran out, so the run reports
 * `Test timeout after …ms at step N` and a failed test, never the amber
 * "stopped" state a Stop gets. A Stop that came first stays a Stop: the timer
 * does not fire on a run the caller already stopped.
 */
import type { StepResult } from '../report/types.js';

/** The longest delay `setTimeout` honours (2^31 − 1 ms, about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;

export class TestDeadline {
  private endsAt: number;
  private controller = new AbortController();
  private composite: AbortSignal;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Nested pauses: a REPL's ad-hoc step can ask a question of its own. */
  private pauses = 0;
  private pausedAt = 0;
  private fired = false;
  private disposed = false;
  /**
   * No deadline at all: the budget is not a finite, non-negative number — a
   * non-numeric `execution.timeout` in the config, say. The check between
   * steps always read a NaN budget as never spent (`Date.now() > NaN` is
   * false), so the timeout was simply off; a timer would instead fire at once
   * (`setTimeout(NaN)` waits 1 ms) and time out every test before its first
   * step. Off it stays. A negative budget used to time out at step 1, which
   * no one can have meant; it is off too. `steptix run --timeout` refuses
   * both outright, so only a config file can still carry one.
   */
  private readonly unbounded: boolean;

  /**
   * @param budgetMs the test's `timeout:`.
   * @param stop the caller's own Stop (`RunTestExtras.signal`), if it has one.
   *   {@link signal} aborts on it too, so a step needs one signal for both.
   */
  constructor(
    readonly budgetMs: number,
    private readonly stop?: AbortSignal,
  ) {
    // `typeof` too: a config file can hand over a string, and `Date.now() +
    // "600"` is string concatenation.
    this.unbounded = !(typeof budgetMs === 'number' && Number.isFinite(budgetMs) && budgetMs >= 0);
    this.endsAt = this.unbounded ? Infinity : Date.now() + budgetMs;
    this.composite = this.compose();
    this.arm();
  }

  /**
   * The signal a step runs under: aborts on the caller's Stop, or when the
   * budget runs out. Read it when the step starts — {@link restart} replaces
   * a signal the timeout already aborted.
   */
  get signal(): AbortSignal {
    return this.composite;
  }

  /** The timer fired: the budget ran out while the run was working. */
  get timedOut(): boolean {
    return this.fired;
  }

  /**
   * The check between steps: is the budget spent? True once the timer has
   * fired, or when the clock has passed the deadline before the timer got its
   * turn. Never while a person is being asked.
   */
  expired(): boolean {
    if (this.fired) return true;
    return this.pauses === 0 && Date.now() > this.endsAt;
  }

  /**
   * A full budget from now — what a REPL's `/resume` and `/continue` have
   * always done, so debugging time is not billed against the test. Renews a
   * signal the timeout had aborted.
   */
  restart(): void {
    this.endsAt = this.unbounded ? Infinity : Date.now() + this.budgetMs;
    if (this.fired) {
      this.fired = false;
      this.controller = new AbortController();
      this.composite = this.compose();
    }
    this.arm();
  }

  /**
   * Wait for a person without spending the budget: the timer stops while
   * `wait` is pending, and the time it took is added back to the deadline.
   * The caller's Stop still reaches the wait through {@link signal}.
   */
  async pause<T>(wait: () => Promise<T>): Promise<T> {
    if (this.pauses++ === 0) {
      this.pausedAt = Date.now();
      this.clear();
    }
    try {
      return await wait();
    } finally {
      if (--this.pauses === 0) {
        this.endsAt += Date.now() - this.pausedAt;
        this.arm();
      }
    }
  }

  /** The run is over: clear the timer so it neither fires late nor holds the
   *  process. Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private compose(): AbortSignal {
    return this.stop ? AbortSignal.any([this.stop, this.controller.signal]) : this.controller.signal;
  }

  private arm(): void {
    this.clear();
    if (this.unbounded || this.disposed || this.fired || this.pauses > 0) return;
    // Capped: Node runs a longer delay after 1 ms instead, which would time
    // out a `timeout: 30000m` test at once. `fire` re-arms for the rest.
    const wait = Math.min(MAX_TIMER_MS, Math.max(0, this.endsAt - Date.now()));
    this.timer = setTimeout(() => this.fire(), wait);
    // A run's deadline is never a reason to keep the process alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private fire(): void {
    this.timer = undefined;
    if (Date.now() < this.endsAt) {
      this.arm();
      return;
    }
    if (this.stop?.aborted) return;
    this.fired = true;
    // No reason given, so the abort reads as an `AbortError` — the name every
    // abort-aware wait and catch already recognises.
    this.controller.abort();
  }

  private clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** The one wording for a timeout, so the console, the report and the old
 *  between-steps check say the same thing. `where` is `step 3`, or a hook. */
export function testTimeoutError(budgetMs: number, where: string): string {
  return `Test timeout after ${budgetMs}ms at ${where}`;
}

/**
 * A step the budget ran out on, as the failure it is.
 *
 * The executors answer an abort with an `interrupted` row — right for a Stop,
 * and wrong for a timeout, which is a failed test (`interrupted` would turn the
 * run's report amber, "stopped"). A failure that came back after the abort is
 * relabelled too: the timeout is what cut it short. `tolerated` goes, because
 * an `otherwise continue` tail does not carry a run past its own deadline.
 */
export function timedOutResult(result: StepResult, error: string): StepResult {
  const { interrupted: _interrupted, tolerated: _tolerated, ...rest } = result;
  return { ...rest, status: 'failed', error, aiExplanation: error };
}
