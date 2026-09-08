/**
 * How a step's status renders in the chat panel — the parts that are decisions
 * rather than DOM.
 *
 * Pulled out of `main.ts` for the reason `output-sections.ts` was: `main.ts`
 * touches `document` at import time, so nothing in it can be unit tested. These
 * three answers are exactly what `skipped` got wrong before
 * (stories/step-flow-control.md): the glyph, whether the row opens itself, and
 * whether the batch error belongs to it.
 */
import type { StepStatus } from '../shared/protocol';

/**
 * The glyph beside a step. ✓ / ✗ / ⚠ as before; ◌ for a step a return left
 * unrun, which is TestBench's skip glyph — the two clients paint the same run
 * and disagreeing about the mark for it helps nobody.
 *
 * Neutral on purpose. A skipped step is not a lesser failure: the author wrote
 * `If the page title contains "Dashboard" then return`, the condition held, and
 * the framework did what it was told.
 */
export function statusGlyph(status: StepStatus): string {
  switch (status) {
    case 'passed':
      return '✓';
    case 'failed':
      return '✗';
    case 'skipped':
      return '◌';
    default:
      return '⚠';
  }
}

/** The `title` / `aria-label` for the glyph — the status, capitalised. */
export function statusLabel(status: StepStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * Whether the row opens itself the first time it renders.
 *
 * Failed and errored steps do, so the user sees what went wrong without
 * hunting. A skipped step does NOT: a return that skips eight steps would
 * otherwise expand eight bodies, each holding no actions, no screenshot and no
 * error — a wall of empty detail announcing that nothing happened. Its one fact
 * is the reason, and that is rendered on the collapsed row instead.
 */
export function autoExpandsOnFirstRender(status: StepStatus): boolean {
  return status === 'failed' || status === 'error';
}

/**
 * Whether the batch's error message belongs to this row.
 *
 * The batch error names the step that FAILED. A skipped step is downstream of
 * a return, never of a failure, so attaching it here would blame the wrong
 * line — and on a passed batch there is no error to attach at all.
 */
export function showsBatchError(status: StepStatus): boolean {
  return status === 'failed' || status === 'error';
}

/**
 * The reason text to show on a collapsed skipped row, or null for every other
 * status.
 *
 * The server sends it as `reasoning` — `Not run: step 2 returned from "Sign
 * in" — If the page title contains "Dashboard" then return`. Shown here rather
 * than behind a click because it is the only thing the row has to say, and a
 * bare ◌ with no explanation reads as a bug in the client.
 */
export function skipReason(status: StepStatus, reasoning: string): string | null {
  if (status !== 'skipped') return null;
  const text = reasoning.trim();
  return text === '' ? null : text;
}
