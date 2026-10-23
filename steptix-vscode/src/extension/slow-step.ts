/**
 * An install that is slow (docs/specs/SPEC-install.md §5.2): there is no time
 * limit, since a slow company connection that works must still finish, but a
 * step that has not moved on for {@link SLOW_STEP_MS} gets a hint added to
 * its progress message.
 *
 * No `vscode` import, and the timer is injected, so the `node --test` suite
 * drives it without waiting; server-setup.ts shows what it says.
 */

/** How long one step may go without moving on before the hint shows. */
export const SLOW_STEP_MS = 3 * 60_000;

export const SLOW_STEP_HINT =
  'This is taking longer than usual. If your company uses a proxy or its own npm registry, ' +
  'check that npm works in a terminal (npm view steptix).';

/** A step's progress message once it has been slow: the step, then the hint. */
export function slowStepMessage(step: string): string {
  return `${step.endsWith('…') ? step : `${step}…`} ${SLOW_STEP_HINT}`;
}

export interface StepTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimer: StepTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Shows each step of an install as it starts and, when one has not moved on
 * for {@link SLOW_STEP_MS}, shows it again with the hint. The next step
 * replaces the hint and starts the wait again. Dispose it when the install
 * ends, so no hint comes after.
 */
export class SlowStepWatch {
  private readonly show: (message: string) => void;
  private readonly timer: StepTimer;
  private current: string | null = null;
  private handle: unknown;

  constructor(show: (message: string) => void, timer: StepTimer = realTimer) {
    this.show = show;
    this.timer = timer;
  }

  step(message: string): void {
    // The same step again has not moved on, so its wait goes on.
    if (message === this.current) return;
    this.stop();
    this.current = message;
    this.show(message);
    this.handle = this.timer.set(() => {
      this.handle = undefined;
      this.show(slowStepMessage(message));
    }, SLOW_STEP_MS);
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    if (this.handle === undefined) return;
    this.timer.clear(this.handle);
    this.handle = undefined;
  }
}
