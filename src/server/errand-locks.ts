/**
 * The per-tab turn lock — stories/errands.md §The wheel.
 *
 * A tab has one steering wheel. Concurrent CDP *clients* on one tab are fine
 * (measured 2026-08-12); concurrent *drivers* are not — interleaved input, two
 * clients racing one dialog, page-global emulation overrides.
 *
 * So a tab being driven by an errand is held, and a second errand is refused
 * rather than queued. Two properties matter more than the mechanism:
 *
 * - **Only errands take it.** Sessions neither take nor consult it. That is the
 *   named, bounded amendment to stories/mcp-cdp-browser.md §Locked's "no
 *   per-port serialisation and no tab-collision guard" — its subject, parallel
 *   sessions, is untouched.
 * - **Finishing IS releasing.** There is no `close_errand` and no release step
 *   anyone can forget: the lease is dropped in the runner's `finally`, so an
 *   errand that throws or aborts still hands every tab back. A detach that
 *   *hangs* is the one case this does not cover — it awaits page closes and a
 *   `bringToFront` with no budget of their own, and the `finally` cannot run
 *   until they settle.
 */

export type ErrandTabRole = 'borrowed' | 'opened';

/** Who holds one tab, and how it came to be theirs. The role is not
 *  decoration: it decides what a refusal can promise about a retry. */
export interface ErrandHold {
  errandId: string;
  tabRole: ErrandTabRole;
}

/**
 * The `holder` field of a 409, as it goes on the wire.
 *
 * Recognisable rather than prose-matched: the MCP side maps this shape onto its
 * own refusal text, and a lock 409 that fell through to the generic HTTP arm
 * would reach a model as "the tab may have been closed" — the opposite of the
 * truth, and advice that sends it to re-list instead of retrying.
 */
export type TabHolder =
  | { kind: 'errand'; errandId: string; tabRole: ErrandTabRole }
  | { kind: 'session'; sessionId: string };

/** A refused borrow: the machine-readable holder, and the prose that rides the
 *  409 body's `error` for any client that does not know the shape. */
export interface ErrandRefusal {
  holder: TabHolder;
  error: string;
}

/**
 * Every tab an errand is currently driving, across every CDP browser.
 *
 * Keyed on **port + targetId**, not targetId alone: target ids are unique
 * within a browser, and nothing stops two browsers on two ports minting the
 * same id.
 */
export class ErrandLocks {
  private readonly held = new Map<string, ErrandHold>();

  /** NUL, because a target id is opaque to us — a printable separator would be
   *  one weird id away from colliding two browsers' tabs into one key. */
  private static key(port: number, targetId: string): string {
    return `${port}\u0000${targetId}`;
  }

  /** Who is driving that tab, or null. Never throws; the close guard calls it
   *  from inside its own port-keyed queue. */
  holder(port: number, targetId: string): ErrandHold | null {
    return this.held.get(ErrandLocks.key(port, targetId)) ?? null;
  }

  /**
   * Take the wheel for `hold.errandId`, or report who already has it.
   *
   * Synchronous on purpose: this is the one operation two concurrent errands
   * race on, and a check-then-set split by an `await` is exactly how both would
   * win. Re-taking a tab this errand already holds succeeds and keeps the
   * ORIGINAL role — a borrowed tab does not become an opened one because a
   * later sweep saw it again.
   */
  acquire(port: number, targetId: string, hold: ErrandHold): ErrandHold | null {
    const key = ErrandLocks.key(port, targetId);
    const existing = this.held.get(key);
    if (existing) return existing.errandId === hold.errandId ? null : existing;
    this.held.set(key, { ...hold });
    return null;
  }

  /** Drop every tab this errand holds. Idempotent — the runner's `finally` and
   *  the route's belt-and-braces `finally` both call it. */
  release(errandId: string): void {
    for (const [key, hold] of this.held) {
      if (hold.errandId === errandId) this.held.delete(key);
    }
  }
}

/**
 * One errand's whole claim on the server: the in-flight run counter and every
 * tab it is driving, released together.
 *
 * Handed out by `ErrandRunner.begin` and released by the run's `finally`. The
 * two live on one object because they have one lifetime — an errand that has
 * released its tabs but still counts as a run in flight would block `aiui stop`
 * forever, and one that has released the counter but not its tabs would block
 * every later errand on those tabs.
 */
export class ErrandLease {
  private released = false;

  constructor(
    readonly errandId: string,
    private readonly port: number,
    private readonly locks: ErrandLocks,
    /** `SessionManager.beginExternalRun`'s release. Idempotent itself. */
    private readonly endRun: () => void,
  ) {}

  /**
   * Claim every tab the errand is now tracking that it does not already hold.
   *
   * Called after each step rather than from a tracker callback: `addPage` is
   * synchronous and the target id it needs is not, so "on track" is only
   * reachable through the same resolved sweep the session join uses. The window
   * this leaves is real — the tab is in the browser's own `/json/list` the
   * moment it exists, so a second errand can name it before this sweep runs —
   * and `holds` is what keeps it harmless: the detach path closes only what the
   * lease still holds.
   *
   * A tab already held by SOMEONE else is left alone rather than stolen — it
   * cannot happen for a tab this errand just opened, and if it somehow did, the
   * wrong answer is to take it.
   */
  claimOpened(targetIds: readonly string[]): void {
    if (this.released) return;
    for (const targetId of targetIds) {
      this.locks.acquire(this.port, targetId, { errandId: this.errandId, tabRole: 'opened' });
    }
  }

  /**
   * Is this errand still the one driving that tab?
   *
   * The detach path's gate. Holding the lock is the only claim that survives
   * the window above: a tab this errand opened but another errand took first is
   * one `claimOpened` declined to steal, and closing it on the way out would
   * kill a tab somebody else is mid-run on.
   */
  holds(targetId: string): boolean {
    if (this.released) return false;
    return this.locks.holder(this.port, targetId)?.errandId === this.errandId;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.locks.release(this.errandId);
    this.endRun();
  }
}

// ---------------------------------------------------------------------------
// Refusal prose
//
// The server's own words, for any client that reads only `error`. The MCP side
// re-words each of these from the `holder` shape for the model that has to act
// on it (src/mcp/errors.ts).
// ---------------------------------------------------------------------------

/** A second errand on a tab an errand already drives. */
export function errandHoldsTabMessage(hold: ErrandHold, targetId: string): string {
  const opened = hold.tabRole === 'opened';
  return (
    `Errand ${hold.errandId} is already driving tab ${targetId}` +
    (opened ? ', a tab it opened during its own run' : '') +
    ', and a tab has one steering wheel.\n\n' +
    'Nothing was started. Wait for that errand to finish and retry — an errand is ' +
    'one request and releases every tab it holds when it returns, so there is no ' +
    'way (and no need) to end it early.' +
    (opened
      ? '\nThat tab will normally be GONE by then: an errand closes what it ' +
        'opened. Re-read the browser\'s tabs before retrying, and expect to name ' +
        'a different one.'
      : '')
  );
}

/** An errand on a tab a session has a batch in flight on. */
export function sessionHoldsTabMessage(sessionId: string, targetId: string): string {
  return (
    `Session "${sessionId}" has a batch in flight on tab ${targetId}, so borrowing ` +
    'it now would mean two drivers on one tab.\n\n' +
    'Nothing was started. Wait for that batch to finish and retry — an idle session ' +
    'on the tab does not block an errand, only a running one does. If the session is ' +
    'no longer wanted, close it first.'
  );
}
