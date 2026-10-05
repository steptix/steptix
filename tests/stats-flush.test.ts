/**
 * The CLI's bounded flush (docs/specs/SPEC-scoreboard.md §6.2; finding 11):
 * `steptix run` exits the moment `runTests` settles — `process.exit(1)` on a
 * throw — so queued lines are flushed in a `finally`, and a stalled append
 * must not be able to hold that exit.
 *
 * The store's queue is replaced here by one whose drain the test controls,
 * which a real disk cannot be made to do on demand. The bound is checked on a
 * fake clock: a real one measures how busy the machine is as much as when the
 * timer fired, and the default bound is two seconds nobody needs to wait.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

const queue = vi.hoisted(() => ({
  /** Resolves the pending flush, when the test drains it by hand. */
  settle: undefined as undefined | (() => void),
  /** Drain on its own after this long; `undefined` never drains. */
  drainAfterMs: undefined as number | undefined,
  /** Told when a flush starts — by then its bound's timer is already set. */
  onFlush: undefined as undefined | (() => void),
  flushes: 0,
  drainedAt: 0,
}));

vi.mock('../src/stats/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/stats/store.js')>()),
  flushStatsWrites: () => {
    queue.flushes++;
    queue.onFlush?.();
    return new Promise<void>((resolve) => {
      const drained = (): void => {
        queue.drainedAt = Date.now();
        resolve();
      };
      queue.settle = drained;
      if (queue.drainAfterMs !== undefined) setTimeout(drained, queue.drainAfterMs);
    });
  },
}));

import { flushRunStats, STATS_FLUSH_TIMEOUT_MS } from '../src/runner/run-stats.js';
import { runTests } from '../src/runner/test-runner.js';
import { parseTestContent } from '../src/parser/markdown.js';

/** Settles once the store has been asked to flush. */
let flushStarted: Promise<void>;

beforeEach(() => {
  queue.settle = undefined;
  queue.drainAfterMs = undefined;
  queue.flushes = 0;
  queue.drainedAt = 0;
  flushStarted = new Promise((resolve) => {
    queue.onFlush = resolve;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Watch a promise without awaiting it: `settled()` says whether it has. */
function watch(p: Promise<unknown>): { settled: () => boolean } {
  let done = false;
  p.then(
    () => { done = true; },
    () => { done = true; },
  );
  return { settled: () => done };
}

describe('flushRunStats', () => {
  it('waits for the queue, but never longer than its bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const flushed = flushRunStats(150);
    const flush = watch(flushed);
    expect(queue.flushes).toBe(1);

    await vi.advanceTimersByTimeAsync(149);
    expect(flush.settled()).toBe(false); // the queue never drains: still waiting

    await vi.advanceTimersByTimeAsync(1);
    expect(flush.settled()).toBe(true); // ...until the bound, and not a tick later
    await flushed;
  });

  it('returns as soon as the queue drains', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const flushed = flushRunStats(10_000);
    const flush = watch(flushed);
    queue.settle!();

    // No time passes at all, so only the drain can have settled it.
    await vi.advanceTimersByTimeAsync(0);
    expect(flush.settled()).toBe(true);
    // And the bound's timer went with it, rather than ticking on for 10 s.
    expect(vi.getTimerCount()).toBe(0);
    await flushed;
  });
});

describe('runTests flushes in a finally (finding 11)', () => {
  const test = () => parseTestContent('# Flush\n\n## Steps\n1. Click Go\n', path.join(os.tmpdir(), 'steptix-flush-test', 'flush.md'));
  const config = {
    ...DEFAULT_CONFIG,
    tests: { ...DEFAULT_CONFIG.tests, contextDir: path.join(os.tmpdir(), 'steptix-flush-test-no-context') },
    reports: { ...DEFAULT_CONFIG.reports, openInBrowserAfterRun: false },
  };

  it('a run that throws waits for its queued lines before the throw reaches `steptix run`', async () => {
    queue.drainAfterMs = 120;
    const failing = runTests([test()], config, {
      runTestFn: async () => {
        throw new Error('the browser would not launch');
      },
    });
    await expect(failing).rejects.toThrow('the browser would not launch');
    const rejectedAt = Date.now();
    expect(queue.flushes).toBe(1);
    // Settled only after the queue drained: the flush was awaited, not fired.
    expect(queue.drainedAt).toBeGreaterThan(0);
    expect(rejectedAt).toBeGreaterThanOrEqual(queue.drainedAt);
  });

  it('a stalled append cannot hold it past the bound', async () => {
    // Never drains. The production bound, spent on the fake clock from the
    // moment the flush starts: the throw must reach `steptix run` exactly
    // then, not a tick before (the flush was skipped) or after (it was not
    // bounded).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const failing = runTests([test()], config, {
      runTestFn: async () => {
        throw new Error('boom');
      },
    });
    const run = watch(failing);

    await flushStarted;
    expect(queue.flushes).toBe(1);

    await vi.advanceTimersByTimeAsync(STATS_FLUSH_TIMEOUT_MS - 1);
    expect(run.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(run.settled()).toBe(true);
    await expect(failing).rejects.toThrow('boom');
  });
});
