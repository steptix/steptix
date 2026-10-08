import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright';
import { waitForPageStability } from '../src/browser/page-state.js';

/**
 * `waitForPageStability`'s `followNavigation` (docs/specs/SPEC-codebehind-robustness.md
 * §6.1).
 *
 * The quiet wait is a script running IN the page, so a navigation that lands
 * during it destroys the script and the wait returns at that instant — the
 * moment a compiled `If the page title contains "Dashboard" then return` most
 * needs it to carry on, because the title it is about to read belongs to a
 * document that is still loading. With the option on, one such navigation is
 * followed: the new document's `domcontentloaded`, then quiet once more, all
 * inside the original budget.
 *
 * A fake page and a fake clock throughout — nothing here sleeps or measures
 * real time. Each quiet-wait attempt advances the clock by the time it is
 * scripted to take and then ends as scripted.
 */

const START = 'http://localhost:8787/index.html';
const DASHBOARD = 'http://localhost:8787/dashboard.html';
const DESTROYED =
  'page.evaluate: Execution context was destroyed, most likely because of a navigation';

interface QuietAttempt {
  /** How long the attempt takes on the fake clock before it ends. */
  ms: number;
  /** Reject with this message instead of resolving. */
  reject?: string;
  /** The page's URL once the attempt has ended — a navigation landed. */
  navigateTo?: string;
}

interface Recorded {
  /** Each quiet-wait attempt: the budget and quiet window its script carried,
   *  and when on the fake clock it began. */
  quiet: Array<{ budgetMs: number; quietMs: number; at: number }>;
  /** Each `waitForLoadState` call. */
  loads: Array<{ state: string; timeout: number | undefined; at: number }>;
}

function fakePage(
  attempts: QuietAttempt[],
  opts: { closed?: boolean; loadMs?: number } = {},
): { page: Page; now: () => number; recorded: Recorded } {
  let clock = 0;
  let url = START;
  const recorded: Recorded = { quiet: [], loads: [] };
  const page = {
    url: () => url,
    isClosed: () => opts.closed === true,
    title: async () => '',
    evaluate: async (script: unknown) => {
      const text = String(script);
      if (!text.includes('MutationObserver')) {
        // The diagnosis `waitForPageStability` ends with.
        return { readyState: 'complete', loadingIndicators: [], errorMessages: [], hasModal: false };
      }
      const timers = [...text.matchAll(/\},\s*(\d+)\);/g)].map((m) => Number(m[1]));
      recorded.quiet.push({ budgetMs: timers[0]!, quietMs: timers[1]!, at: clock });
      const attempt = attempts[recorded.quiet.length - 1];
      if (!attempt) throw new Error(`quiet-wait attempt ${recorded.quiet.length} was not scripted`);
      clock += attempt.ms;
      if (attempt.navigateTo !== undefined) url = attempt.navigateTo;
      if (attempt.reject !== undefined) throw new Error(attempt.reject);
      return undefined;
    },
    waitForLoadState: async (state: string, o?: { timeout?: number }) => {
      recorded.loads.push({ state, timeout: o?.timeout, at: clock });
      clock += opts.loadMs ?? 0;
    },
  } as unknown as Page;
  return { page, now: () => clock, recorded };
}

describe('waitForPageStability — followNavigation', () => {
  it('follows a navigation that destroyed the quiet wait: domcontentloaded, then quiet again', async () => {
    const { page, now, recorded } = fakePage(
      [
        { ms: 300, reject: DESTROYED, navigateTo: DASHBOARD },
        { ms: 1000 },
      ],
      { loadMs: 200 },
    );

    await waitForPageStability(page, { timeoutMs: 10_000, quiesceMs: 1000, followNavigation: true, now });

    expect(recorded.quiet).toHaveLength(2);
    expect(recorded.loads).toEqual([{ state: 'domcontentloaded', timeout: 9700, at: 300 }]);
    // The second quiet wait is the same kind of wait as the first …
    expect(recorded.quiet[1]!.quietMs).toBe(1000);
  });

  it('keeps the budget: each later wait gets only what is left of it', async () => {
    const { page, now, recorded } = fakePage(
      [
        { ms: 2500, reject: DESTROYED, navigateTo: DASHBOARD },
        { ms: 1000 },
      ],
      { loadMs: 1500 },
    );

    await waitForPageStability(page, { timeoutMs: 10_000, quiesceMs: 1000, followNavigation: true, now });

    expect(recorded.quiet.map((q) => q.budgetMs)).toEqual([10_000, 6000]);
    expect(recorded.loads[0]!.timeout).toBe(7500);
    // Never past the deadline it started with.
    expect(now()).toBeLessThanOrEqual(10_000);
  });

  it('skips the second quiet wait when what is left cannot hold a quiet window', async () => {
    const { page, now, recorded } = fakePage(
      [{ ms: 8000, reject: DESTROYED, navigateTo: DASHBOARD }],
      { loadMs: 1500 },
    );

    await waitForPageStability(page, { timeoutMs: 10_000, quiesceMs: 1000, followNavigation: true, now });

    expect(recorded.loads).toHaveLength(1);
    expect(recorded.quiet).toHaveLength(1);
  });

  it('follows at most one navigation: a second rejection returns', async () => {
    const { page, now, recorded } = fakePage([
      { ms: 300, reject: DESTROYED, navigateTo: DASHBOARD },
      { ms: 300, reject: DESTROYED, navigateTo: `${DASHBOARD}?again` },
    ]);

    await waitForPageStability(page, { timeoutMs: 10_000, quiesceMs: 1000, followNavigation: true, now });

    expect(recorded.quiet).toHaveLength(2);
    expect(recorded.loads).toHaveLength(1);
  });

  it('counts a changed URL as a navigation even when the error does not say so', async () => {
    const { page, now, recorded } = fakePage([
      { ms: 300, reject: 'page.evaluate: Target frame was detached', navigateTo: DASHBOARD },
      { ms: 1000 },
    ]);

    await waitForPageStability(page, { timeoutMs: 10_000, quiesceMs: 1000, followNavigation: true, now });

    expect(recorded.loads).toHaveLength(1);
    expect(recorded.quiet).toHaveLength(2);
  });

  it('returns at once from a closed page', async () => {
    const { page, now, recorded } = fakePage(
      [{ ms: 300, reject: DESTROYED, navigateTo: DASHBOARD }],
      { closed: true },
    );

    await waitForPageStability(page, { timeoutMs: 10_000, quiesceMs: 1000, followNavigation: true, now });

    expect(recorded.quiet).toHaveLength(1);
    expect(recorded.loads).toEqual([]);
  });

  it('returns at once, as before, on any other rejection — an unchanged URL and a generic error', async () => {
    const { page, now, recorded } = fakePage([{ ms: 0, reject: 'no DOM in this test' }]);

    await waitForPageStability(page, { timeoutMs: 10_000, quiesceMs: 1000, followNavigation: true, now });

    expect(recorded.quiet).toHaveLength(1);
    expect(recorded.loads).toEqual([]);
  });

  it('keeps today\'s behaviour without the option: a navigation ends the wait', async () => {
    const { page, now, recorded } = fakePage([{ ms: 300, reject: DESTROYED, navigateTo: DASHBOARD }]);

    await waitForPageStability(page, { timeoutMs: 10_000, quiesceMs: 1000, now });

    expect(recorded.quiet).toHaveLength(1);
    expect(recorded.loads).toEqual([]);
  });

  it('a wait that ends quietly is one quiet wait, with or without the option', async () => {
    for (const followNavigation of [false, true]) {
      const { page, now, recorded } = fakePage([{ ms: 1000 }]);
      await waitForPageStability(page, { timeoutMs: 10_000, quiesceMs: 1000, followNavigation, now });
      expect(recorded.quiet).toEqual([{ budgetMs: 10_000, quietMs: 1000, at: 0 }]);
      expect(recorded.loads).toEqual([]);
    }
  });
});
