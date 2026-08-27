/**
 * Hover text for failed (✗) and stale (⚠) step lines — pure string building,
 * no VS Code dependency, so the fast `node --test` suite can pin the wording.
 *
 * The marks alone say "something went wrong here" and stop; these hovers are
 * where the actual error lives, pinned to the line, so the user doesn't have
 * to scroll the run log to find out what a code-behind step died of
 * (issues/…-surface-codebehind-errors). Rendered as Markdown by the editor's
 * decoration hover.
 */

import type { StepFailureDetail } from 'ai-ui-automation-runner-core';

/** Keep hovers readable — a Playwright call log can run to pages. The full
 *  text is still in the run log and the report. */
const MAX_ERROR_CHARS = 1000;

/**
 * The ⚠'s action line. Names the command that fixes a stale entry and, in
 * the same breath, the one precondition the framework cannot check for the
 * author: Repair re-runs the step, so the session has to be parked somewhere
 * the step makes sense (stories/codebehind-selector-ambiguity.md §Repair).
 *
 * Deliberately not a gate and must never become one — the framework has no
 * way to know whether a page satisfies a natural-language step's
 * precondition, so the honest move is to say what the action does and let a
 * wrong page fail the step normally.
 */
const REPAIR_HINT =
  '**Repair this step** (right-click the line number) re-runs this step in the ' +
  'current session and regenerates its entry from the failure.';

/**
 * What the ⚠ says when the tracker has no failure detail for the line —
 * state persisted by an older build, or a stale mark painted without an
 * error on the wire. Exported so a test asserts THIS string rather than a
 * copy of it.
 */
export const STALE_HOVER_MESSAGE =
  'This step passed under AI — its compiled code-behind threw.\n\n' + REPAIR_HINT;

/** The error, fenced so multi-line Playwright call logs keep their shape,
 *  clipped so a hover stays a hover. */
function fenced(text: string): string {
  const clipped =
    text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
  // A ``` inside the error would end the fence early and render the rest as
  // stray Markdown; soften it. Nothing real emits one, this is a seatbelt.
  return '```\n' + clipped.replace(/```/g, "'''") + '\n```';
}

/**
 * Hover for a ⚠ (`pass-stale`) line. With a detail it leads with the actual
 * crash and the entry's file; without one it falls back to the static text.
 */
export function staleHoverMessage(failure?: StepFailureDetail): string {
  const cb = failure?.codeBehindStale;
  if (!cb) return STALE_HOVER_MESSAGE;
  return (
    'This step passed under AI — its compiled code-behind threw:\n\n' +
    `${fenced(cb.error)}\n\n` +
    `\`${cb.file}\`\n\n` +
    REPAIR_HINT
  );
}

/**
 * Hover for a ✗ (`fail`) line. Three shapes, by where the failure came from:
 * the step's own code-behind (a failed `step.expect`, or the entry throwing
 * under strict replay), a heal whose AI attempt failed too — which shows
 * BOTH errors, the crash and the AI failure — or a plain AI-run failure.
 */
export function failHoverMessage(failure: StepFailureDetail): string {
  const error = failure.error ?? '';
  if (failure.codeBehindStale) {
    return (
      'This step failed — its compiled code-behind threw, and the AI attempt ' +
      'that took over failed too.\n\n' +
      `Code-behind error (\`${failure.codeBehindStale.file}\`):\n\n` +
      `${fenced(failure.codeBehindStale.error)}\n\n` +
      'Then, under AI:\n\n' +
      fenced(error)
    );
  }
  if (failure.fromCodeBehind) {
    return `This step's code-behind failed:\n\n${fenced(error)}`;
  }
  return `This step failed:\n\n${fenced(error)}`;
}
