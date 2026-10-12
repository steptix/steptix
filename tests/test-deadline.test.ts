/**
 * `TestDeadline` (src/runner/test-deadline.ts) — the test's `timeout:` as a
 * timer that aborts the step in flight (steptix/steptix#47).
 *
 * Fake timers throughout, `Date` included, so the timer and the between-steps
 * check read one clock and nothing here waits in real time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestDeadline, testTimeoutError, timedOutResult } from '../src/runner/test-deadline.js';
import type { StepResult } from '../src/report/types.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TestDeadline', () => {
  it('aborts its signal when the budget runs out, and says it timed out', () => {
    const deadline = new TestDeadline(1000);
    try {
      vi.advanceTimersByTime(999);
      expect(deadline.signal.aborted).toBe(false);
      expect(deadline.expired()).toBe(false);

      vi.advanceTimersByTime(1);
      expect(deadline.signal.aborted).toBe(true);
      // An AbortError: the name every abort-aware wait already recognises.
      expect((deadline.signal.reason as Error).name).toBe('AbortError');
      expect(deadline.timedOut).toBe(true);
      expect(deadline.expired()).toBe(true);
    } finally {
      deadline.dispose();
    }
  });

  it('stops while a person is asked, and gives that time back', async () => {
    const deadline = new TestDeadline(1000);
    try {
      vi.advanceTimersByTime(600);
      let answer!: (value: string) => void;
      const asked = deadline.pause(() => new Promise<string>((resolve) => { answer = resolve; }));

      // Far past the budget while the person types: nothing fires.
      vi.advanceTimersByTime(60_000);
      expect(deadline.signal.aborted).toBe(false);
      expect(deadline.expired()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      answer('Ada');
      await expect(asked).resolves.toBe('Ada');

      // The 400 ms left before the pause are still left after it.
      vi.advanceTimersByTime(399);
      expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(deadline.timedOut).toBe(true);
    } finally {
      deadline.dispose();
    }
  });

  it('a nested pause resumes the clock only when the outer one ends', async () => {
    const deadline = new TestDeadline(1000);
    try {
      let endOuter!: () => void;
      const outer = deadline.pause(async () => {
        await deadline.pause(async () => {
          vi.advanceTimersByTime(5000);
        });
        // The inner pause is over; the outer one still holds the clock.
        vi.advanceTimersByTime(5000);
        expect(deadline.signal.aborted).toBe(false);
        await new Promise<void>((resolve) => { endOuter = resolve; });
      });
      await vi.waitFor(() => expect(endOuter).toBeTypeOf('function'));
      endOuter();
      await outer;

      vi.advanceTimersByTime(999);
      expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(deadline.timedOut).toBe(true);
    } finally {
      deadline.dispose();
    }
  });

  it('restart gives a full budget and a fresh signal after a timeout', () => {
    const deadline = new TestDeadline(1000);
    try {
      vi.advanceTimersByTime(1000);
      const spent = deadline.signal;
      expect(spent.aborted).toBe(true);

      deadline.restart();
      expect(deadline.timedOut).toBe(false);
      expect(deadline.expired()).toBe(false);
      expect(deadline.signal).not.toBe(spent);
      expect(deadline.signal.aborted).toBe(false);

      vi.advanceTimersByTime(999);
      expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(deadline.timedOut).toBe(true);
    } finally {
      deadline.dispose();
    }
  });

  it("carries the caller's Stop, which is never a timeout", () => {
    const stop = new AbortController();
    const deadline = new TestDeadline(1000, stop.signal);
    try {
      stop.abort();
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.timedOut).toBe(false);

      // The budget running out after the Stop does not relabel it.
      vi.advanceTimersByTime(1000);
      expect(deadline.timedOut).toBe(false);
    } finally {
      deadline.dispose();
    }
  });

  it('a timeout first stays a timeout when a Stop follows', () => {
    const stop = new AbortController();
    const deadline = new TestDeadline(1000, stop.signal);
    try {
      vi.advanceTimersByTime(1000);
      stop.abort();
      expect(deadline.timedOut).toBe(true);
    } finally {
      deadline.dispose();
    }
  });

  it('a budget longer than a timer can hold still runs to its end', () => {
    // Node runs a delay past 2^31 − 1 ms after 1 ms instead.
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const deadline = new TestDeadline(thirtyDays);
    try {
      vi.advanceTimersByTime(1);
      expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(2_147_483_647);
      expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(thirtyDays - 2_147_483_648 - 1);
      expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(deadline.timedOut).toBe(true);
    } finally {
      deadline.dispose();
    }
  });

  // `--timeout abc` used to arrive as NaN, and a config file can hold
  // anything. The check between steps never fired on such a budget
  // (`Date.now() > NaN` is false); a timer would fire after 1 ms and time out
  // every test before its first step. So: no deadline, as before. A negative
  // budget used to time out at step 1; it is no deadline now too.
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative budget', -1],
    ['a string from a config file', '600' as unknown as number],
  ])('%s is no deadline at all', async (_name, budget) => {
    const deadline = new TestDeadline(budget);
    try {
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
      expect(deadline.expired()).toBe(false);
      expect(deadline.timedOut).toBe(false);
      expect(deadline.signal.aborted).toBe(false);
      // Restarting, or pausing for a person, arms nothing either.
      deadline.restart();
      expect(vi.getTimerCount()).toBe(0);
      expect(deadline.expired()).toBe(false);
      await deadline.pause(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(deadline.expired()).toBe(false);
    } finally {
      deadline.dispose();
    }
  });

  it('no deadline still carries the Stop', () => {
    const stop = new AbortController();
    const deadline = new TestDeadline(Number.NaN, stop.signal);
    try {
      stop.abort();
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.timedOut).toBe(false);
    } finally {
      deadline.dispose();
    }
  });

  it('dispose clears the timer, so it can neither fire later nor hold the process', () => {
    const deadline = new TestDeadline(1000);
    expect(vi.getTimerCount()).toBe(1);
    deadline.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(deadline.signal.aborted).toBe(false);
    // Restarting a disposed deadline arms nothing.
    deadline.restart();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('timedOutResult', () => {
  it('turns the Stop-shaped row an abort leaves into a failed, untolerated timeout', () => {
    const interrupted: StepResult = {
      index: 2,
      instruction: 'Click Save',
      status: 'failed',
      turns: [],
      durationMs: 5,
      retried: false,
      interrupted: true,
      tolerated: true,
      error: 'Aborted by client',
      aiExplanation: 'Step aborted by client (run stopped).',
    };
    const error = testTimeoutError(600_000, 'step 2');
    expect(error).toBe('Test timeout after 600000ms at step 2');

    const result = timedOutResult(interrupted, error);
    expect(result.status).toBe('failed');
    expect(result.error).toBe(error);
    expect(result.aiExplanation).toBe(error);
    expect(result).not.toHaveProperty('interrupted');
    expect(result).not.toHaveProperty('tolerated');
    expect(result.instruction).toBe('Click Save');
  });
});
