/**
 * The CLI's bounded flush (docs/specs/SPEC-scoreboard.md §6.2; finding 11):
 * `aiui run` exits the moment `runTests` settles — `process.exit(1)` on a
 * throw — so queued lines are flushed in a `finally`, and a stalled append
 * must not be able to hold that exit.
 *
 * The store's queue is replaced here by one whose drain the test controls,
 * which a real disk cannot be made to do on demand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';

const queue = vi.hoisted(() => ({
  /** Resolves the pending flush, when the test drains it by hand. */
  settle: undefined as undefined | (() => void),
  /** Drain on its own after this long; `undefined` never drains. */
  drainAfterMs: undefined as number | undefined,
  flushes: 0,
  drainedAt: 0,
}));

vi.mock('../src/stats/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/stats/store.js')>()),
  flushStatsWrites: () => {
    queue.flushes++;
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

beforeEach(() => {
  queue.settle = undefined;
  queue.drainAfterMs = undefined;
  queue.flushes = 0;
  queue.drainedAt = 0;
});

describe('flushRunStats', () => {
  it('waits for the queue, but never longer than its bound', async () => {
    const started = Date.now();
    await flushRunStats(150);
    const waited = Date.now() - started;
    expect(queue.flushes).toBe(1);
    expect(waited).toBeGreaterThanOrEqual(140);
    expect(waited).toBeLessThan(2_000);
  });

  it('returns as soon as the queue drains', async () => {
    const started = Date.now();
    const flushed = flushRunStats(10_000);
    queue.settle!();
    await flushed;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('bounds `aiui run` at two seconds by default', () => {
    expect(STATS_FLUSH_TIMEOUT_MS).toBe(2_000);
  });
});

describe('runTests flushes in a finally (finding 11)', () => {
  const test = () => parseTestContent('# Flush\n\n## Steps\n1. Click Go\n', path.join(os.tmpdir(), 'aiui-flush-test', 'flush.md'));
  const config = {
    ...DEFAULT_CONFIG,
    tests: { ...DEFAULT_CONFIG.tests, contextDir: path.join(os.tmpdir(), 'aiui-flush-test-no-context') },
    reports: { ...DEFAULT_CONFIG.reports, openInBrowserAfterRun: false },
  };

  it('a run that throws waits for its queued lines before the throw reaches `aiui run`', async () => {
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
    // Never drains.
    const started = Date.now();
    await expect(
      runTests([test()], config, {
        runTestFn: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    const waited = Date.now() - started;
    expect(queue.flushes).toBe(1);
    expect(waited).toBeGreaterThanOrEqual(STATS_FLUSH_TIMEOUT_MS - 50);
    expect(waited).toBeLessThan(STATS_FLUSH_TIMEOUT_MS + 2_000);
  }, 10_000);
});
