import { describe, it, expect, vi, afterEach } from 'vitest';
import { IdleMonitor, startIdleReaper } from '../src/server/idle-monitor.js';

/**
 * The idle definition (stories/server-lifecycle.md §3) has two halves:
 * "no authenticated request for N minutes" (this class) AND "no run in
 * flight" (the caller's `runsInFlight()` check). These tests pin the first
 * half plus the AND, driven with a fake clock so expiry doesn't take an hour.
 */
describe('IdleMonitor', () => {
  /** Fake clock — `t.advance(ms)` moves time forward. */
  function fakeClock(start = 1_000_000) {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  }

  it('is disarmed when no timeout is configured', () => {
    for (const value of [undefined, null, 0]) {
      const monitor = new IdleMonitor(value);
      expect(monitor.armed).toBe(false);
      expect(monitor.timeoutMinutes).toBeNull();
      expect(monitor.isExpired()).toBe(false);
    }
  });

  it('never expires while disarmed, however long the silence', () => {
    const clock = fakeClock();
    const monitor = new IdleMonitor(0, clock.now);
    clock.advance(24 * 60 * 60_000);
    expect(monitor.isExpired()).toBe(false);
  });

  it('expires only once the window has fully elapsed', () => {
    const clock = fakeClock();
    const monitor = new IdleMonitor(60, clock.now);

    clock.advance(59 * 60_000);
    expect(monitor.isExpired()).toBe(false);

    clock.advance(60_000); // exactly 60m — the window is "> N", not ">="
    expect(monitor.isExpired()).toBe(false);

    clock.advance(1);
    expect(monitor.isExpired()).toBe(true);
  });

  it('bump() resets the window', () => {
    const clock = fakeClock();
    const monitor = new IdleMonitor(60, clock.now);

    clock.advance(59 * 60_000);
    monitor.bump();
    clock.advance(59 * 60_000);
    expect(monitor.isExpired()).toBe(false);

    clock.advance(2 * 60_000);
    expect(monitor.isExpired()).toBe(true);
  });

  it('idleFor() reports elapsed time since the last bump', () => {
    const clock = fakeClock();
    const monitor = new IdleMonitor(60, clock.now);
    clock.advance(90_000);
    expect(monitor.idleFor()).toBe(90_000);
    monitor.bump();
    expect(monitor.idleFor()).toBe(0);
  });

  it('idleFor() is unaffected by the configured window', () => {
    const clock = fakeClock();
    const monitor = new IdleMonitor(null, clock.now);
    clock.advance(5_000);
    expect(monitor.idleFor()).toBe(5_000);
  });
});

/**
 * The rule that actually ships is the CONJUNCTION — no run in flight AND a
 * stale timestamp — so it is tested through the shipped reaper rather than a
 * hand-written copy of the predicate.
 */
describe('startIdleReaper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Wire a reaper over a fake clock + fake timers. */
  function setup(timeoutMinutes: number | null, opts: { busy?: boolean } = {}) {
    vi.useFakeTimers();
    let now = 1_000_000;
    const monitor = new IdleMonitor(timeoutMinutes, () => now);
    const state = { busy: opts.busy ?? false, expired: 0 };
    const stop = startIdleReaper({
      monitor,
      isBusy: () => state.busy,
      onExpire: () => state.expired++,
      intervalMs: 1_000,
    });
    /** Advance BOTH clocks — the monitor's notion of time and the timer's. */
    const advance = (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    };
    return { monitor, state, stop, advance };
  }

  it('fires once the window elapses with nothing in flight', () => {
    const { state, advance, stop } = setup(60);

    advance(59 * 60_000);
    expect(state.expired).toBe(0);

    advance(2 * 60_000);
    expect(state.expired).toBe(1);
    stop();
  });

  it('does not fire while a run is in flight, however long the silence', () => {
    const { state, advance, stop } = setup(60, { busy: true });

    advance(10 * 60 * 60_000); // ten hours of silence
    expect(state.expired).toBe(0);
    stop();
  });

  // Regression: a run in flight must pin the TIMER, not just the decision.
  // Otherwise a run longer than the window leaves the timestamp already stale
  // when it ends, and the very next tick reaps the server seconds after the
  // user got their results — closing the browser they kept open to reuse.
  it('restarts the full window when a long run finishes', () => {
    const { state, advance, stop } = setup(60, { busy: true });

    advance(90 * 60_000); // a 90-minute run, longer than the 60m window
    state.busy = false;

    advance(59 * 60_000);
    expect(state.expired).toBe(0); // the window runs from the END of the run

    advance(2 * 60_000);
    expect(state.expired).toBe(1);
    stop();
  });

  // An open-but-idle SESSION is not a run, so it never enters this rule.
  it('fires on the next tick once the run ends inside the window', () => {
    const { state, advance, stop } = setup(60, { busy: true });

    advance(30 * 60_000);
    state.busy = false;
    advance(61 * 60_000);

    expect(state.expired).toBe(1);
    stop();
  });

  it('fires at most once, even if teardown is slow', () => {
    const { state, advance, stop } = setup(60);
    advance(61 * 60_000);
    advance(60 * 60_000);
    expect(state.expired).toBe(1);
    stop();
  });

  it('is re-armed by activity inside the window', () => {
    const { monitor, state, advance, stop } = setup(60);

    advance(59 * 60_000);
    monitor.bump();
    advance(59 * 60_000);
    expect(state.expired).toBe(0);
    stop();
  });

  it('starts no timer at all when the monitor is disarmed', () => {
    // The default configuration has no idle timeout, so the common case must
    // not wake the event loop 2,880 times a day to immediately return.
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const stop = startIdleReaper({
      monitor: new IdleMonitor(0),
      isBusy: () => false,
      onExpire: () => {
        throw new Error('must not fire');
      },
    });
    expect(setIntervalSpy).not.toHaveBeenCalled();
    stop();
  });

  it('stops firing once the returned disposer runs', () => {
    const { state, advance, stop } = setup(60);
    stop();
    advance(61 * 60_000);
    expect(state.expired).toBe(0);
  });
});
