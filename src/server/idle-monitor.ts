/**
 * Tracks how long the server has gone without *authenticated* API traffic.
 *
 * "Idle" for shutdown purposes is **no run in flight AND no authenticated
 * request for N minutes** — deliberately NOT "no open sessions". Interactive
 * TestBench runs keep their session (and browser) open indefinitely for reuse
 * and survive VS Code reloads by design, so a session-count-based definition
 * would never fire. See stories/server-lifecycle.md §3.
 *
 * Only the auth middleware bumps this. `GET /health` sits *before* auth
 * precisely so the status bar's 30 s poll cannot keep the server alive
 * forever — that would make the idle timeout dead code.
 *
 * The clock is injected so tests can drive expiry with fake time rather than
 * waiting minutes.
 */
export class IdleMonitor {
  private lastActivity: number;
  private readonly now: () => number;

  /** Configured window in minutes; `null`/0 ⇒ no shutdown is ever armed. */
  readonly timeoutMinutes: number | null;

  constructor(timeoutMinutes?: number | null, now: () => number = Date.now) {
    this.now = now;
    this.timeoutMinutes = timeoutMinutes && timeoutMinutes > 0 ? timeoutMinutes : null;
    this.lastActivity = this.now();
  }

  /** True when an idle shutdown is configured at all. */
  get armed(): boolean {
    return this.timeoutMinutes !== null;
  }

  /** Record authenticated activity. Called from the auth middleware. */
  bump(): void {
    this.lastActivity = this.now();
  }

  /** Milliseconds since the last authenticated request. */
  idleFor(): number {
    return this.now() - this.lastActivity;
  }

  /**
   * Whether the idle window has elapsed. Says nothing about runs in flight —
   * the caller ANDs this with `runsInFlight() === 0`, keeping the two halves
   * of the idle definition (§3) visible at the one call site that acts on it.
   */
  isExpired(): boolean {
    if (this.timeoutMinutes === null) return false;
    return this.idleFor() > this.timeoutMinutes * 60_000;
  }
}

/** How often the reaper checks. Cheap — two counter reads and a subtraction. */
export const IDLE_CHECK_INTERVAL_MS = 30_000;

/**
 * Poll `monitor` and fire `onExpire` once the server is idle by BOTH halves
 * of the §3 definition: no run in flight AND no authenticated traffic for the
 * configured window.
 *
 * A free function rather than inline `setInterval` in `startServer` so the
 * conjunction that actually ships is the one under test — an idle rule that
 * can only be exercised by booting a real server tends to get "verified" by a
 * hand-written copy of itself in the test file.
 *
 * Returns a stop function. Returns a no-op (and starts no timer) when the
 * monitor is disarmed, which is the default configuration — no point waking
 * the event loop 2,880 times a day to immediately return.
 */
export function startIdleReaper(opts: {
  monitor: IdleMonitor;
  /** Runs in flight — a busy server is never idle, however quiet the socket. */
  isBusy: () => boolean;
  onExpire: () => void;
  intervalMs?: number;
}): () => void {
  const { monitor, isBusy, onExpire, intervalMs = IDLE_CHECK_INTERVAL_MS } = opts;
  if (!monitor.armed) return () => {};

  let fired = false;
  const timer = setInterval(() => {
    // One-shot: teardown is async, and a second expiry firing into a
    // half-torn-down server has nothing useful to do.
    if (fired) return;

    if (isBusy()) {
      // A run in flight pins the TIMER, not merely the decision. Without the
      // bump, a run longer than the window leaves `lastActivity` already
      // stale when it finishes, so the next tick reaps the server seconds
      // after the user got their results — closing the browser they kept the
      // session open to reuse. The locked AND is preserved: this just means
      // the window is measured from when the server last had work, which is
      // what "idle for 60m" says.
      monitor.bump();
      return;
    }

    if (!monitor.isExpired()) return;
    fired = true;
    onExpire();
  }, intervalMs);
  // The reaper alone must not hold the process open.
  timer.unref?.();

  return () => clearInterval(timer);
}
