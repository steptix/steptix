/**
 * Computer-mode stall detection (docs/specs/SPEC-use-computer.md §5.5).
 *
 * The page loop detects a stall by reading the DOM. There is no DOM here, so
 * the question is asked of the two things this surface does have: three
 * consecutive turns whose captures are pixel-identical AND whose actions were
 * identical. Either alone is normal — a screen that has not changed while the
 * model tries something new is progress, and the same action against a
 * changing screen is a scroll.
 *
 * The comparison is over a HASH rather than the base64 PNG. A full-screen
 * capture is megabytes; holding three of them per session to compare strings
 * would cost more memory than the whole surface, and a 32-byte digest answers
 * "are these the same pixels" exactly as well.
 */
import { createHash } from 'node:crypto';
import type { ComputerAction } from './actions.js';

/** §5.5 — how many identical turns in a row is a stall. */
export const COMPUTER_STALL_TURNS = 3;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * A stable fingerprint of what the model asked for.
 *
 * `raw` is dropped: it is the model's own object, kept on each action for the
 * run loop, and two responses that differ only in whitespace or key order
 * inside it asked for exactly the same thing. Comparing it would make a stall
 * undetectable behind a reformatted envelope.
 */
export function fingerprintActions(actions: readonly ComputerAction[] | string): string {
  if (typeof actions === 'string') return actions.trim();
  return JSON.stringify(
    actions.map((action) => {
      const { raw: _raw, ...rest } = action as ComputerAction & { raw?: unknown };
      const entries = Object.entries(rest).sort(([a], [b]) => a.localeCompare(b));
      return Object.fromEntries(entries);
    }),
  );
}

export class ComputerStallDetector {
  private lastKey: string | null = null;
  private streak = 0;

  /** How many consecutive turns have now been identical (1 for a fresh one). */
  get consecutive(): number {
    return this.streak;
  }

  get stalled(): boolean {
    return this.streak >= COMPUTER_STALL_TURNS;
  }

  /**
   * Record one turn. Returns true once {@link COMPUTER_STALL_TURNS} turns in a
   * row have had the same capture AND the same actions.
   */
  observe(pngBase64: string, actions: readonly ComputerAction[] | string): boolean {
    const key = sha256(`${sha256(pngBase64)}\n${sha256(fingerprintActions(actions))}`);
    this.streak = key === this.lastKey ? this.streak + 1 : 1;
    this.lastKey = key;
    return this.stalled;
  }

  reset(): void {
    this.lastKey = null;
    this.streak = 0;
  }
}

/** The message the step fails with, naming the stall (§5.5). */
export function computerStallMessage(stepText?: string): string {
  const subject = stepText ? ` on step "${stepText}"` : '';
  return (
    `Computer mode stalled${subject}: ${COMPUTER_STALL_TURNS} turns in a row produced an ` +
    'identical screenshot and an identical action, so the screen is not responding to what the ' +
    'model is doing.'
  );
}
