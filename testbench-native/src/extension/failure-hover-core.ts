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
 *  clipped so a hover stays a hover.
 *
 *  Exported for the row hovers (`row-summary-core.ts`), which are *not* built
 *  by `failHoverMessage` — a row's hover leads with prose the step's does not
 *  have — but must fence and clip an error identically, so the same
 *  Playwright log reads the same on a row and on the step it died at. */
export function fenced(text: string): string {
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
 * The opening line of a DELIBERATE ✗'s hover — the `fail` verb
 * (stories/step-failure-outcomes.md, decision 2).
 *
 * "as its text says" is the whole job of the sentence: what follows is the author's
 * message, not a diagnostic, so a reader who takes it for the framework's wording
 * goes looking for a stack trace that does not exist. Exported so a test asserts
 * THIS string rather than a copy.
 */
export const DELIBERATE_HOVER_OPENING = 'This step failed as its text says:';

/**
 * Hover for a ✗ (`fail`) line. Three shapes, by where the failure came from:
 * the step's own code-behind (a failed `step.expect`, or the entry throwing
 * under strict replay), a heal whose AI attempt failed too — which shows
 * BOTH errors, the crash and the AI failure — or a plain AI-run failure.
 */
export function failHoverMessage(failure: StepFailureDetail): string {
  const error = failure.error ?? '';
  // A DELIBERATE failure first, ahead of every code-behind shape below
  // (stories/step-failure-outcomes.md, decision 2). `step.fail()` throws the class
  // a failed `step.expect` throws, so a COMPILED one arrives with `fromCodeBehind`
  // set — and "This step's code-behind failed:" over the author's own sentence
  // sends the reader to the `.steps.ts` for a bug that is not there. The
  // code-behind fact is kept; it is just no longer the headline.
  if (failure.deliberate) {
    return (
      `${DELIBERATE_HOVER_OPENING}${failure.fromCodeBehind ? ' (via its code-behind)' : ''}\n\n` +
      fenced(error)
    );
  }
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

/**
 * The opening line of a tolerated ✗'s hover
 * (stories/step-failure-outcomes.md, decision 6).
 *
 * It names the tail that caused it, because that is the reader's actual question:
 * an amber ✗ on a green run looks like a bug in the tool until you know a line of
 * the test asked for it, and the run log has usually scrolled by then. Exported so
 * a test asserts THIS string rather than a copy.
 */
export const TOLERATED_HOVER_OPENING =
  'This step failed and the run continued past it (otherwise continue):';

/**
 * The body line of a tolerated ✗ whose failure was also DELIBERATE — a
 * `step.fail()` inside the entry of a step carrying `otherwise continue`
 * (stories/step-failure-outcomes.md, decisions 2 and 6).
 *
 * It stands where "Its code-behind failed:" stands for an ordinary tolerated
 * failure and says the opposite about the same entry: the code did what the author
 * wrote, and the text below is their sentence rather than a diagnostic.
 */
export const DELIBERATE_TOLERATED_BODY = 'It failed as its text says';

/**
 * Hover for an amber ✗ (`fail-tolerated`) line.
 *
 * The same three shapes `failHoverMessage` has, under a different opening: a
 * tolerated failure can come out of a code-behind entry as easily as out of an AI
 * turn, and dropping the crash here would hide it on exactly the runs nobody looks
 * at twice. Same fencing and clip, so an identical Playwright log reads identically
 * whether the step stopped the run or not.
 */
export function toleratedHoverMessage(failure: StepFailureDetail): string {
  const error = failure.error ?? '';
  // The two flags compose (decisions 2 and 6): a hand-written `step.fail()` inside
  // the entry of a step carrying `otherwise continue` is deliberate AND tolerated,
  // and it arrives `fromCodeBehind` too — so the ordinary body line below, "Its
  // code-behind failed:", would accuse a working entry. The fix `failHoverMessage`
  // already makes for the red ✗, on the amber one.
  const body =
    failure.deliberate === true
      ? `${DELIBERATE_TOLERATED_BODY}${failure.fromCodeBehind ? ' (via its code-behind)' : ''}:`
      : failure.fromCodeBehind
        ? 'Its code-behind failed:'
        : undefined;
  // The author's warning is the FIRST line whenever they wrote one (decision 6): it
  // answers the question the hover is opened to ask — why was this survivable —
  // which the framework's error, keeping its place below, does not. Prose rather
  // than fenced, since it is a sentence somebody wrote.
  const opening =
    failure.warning !== undefined && failure.warning !== ''
      ? `${failure.warning}\n\n${TOLERATED_HOVER_OPENING}`
      : TOLERATED_HOVER_OPENING;
  if (failure.codeBehindStale) {
    return (
      `${opening}\n\n` +
      `Code-behind error (\`${failure.codeBehindStale.file}\`):\n\n` +
      `${fenced(failure.codeBehindStale.error)}\n\n` +
      'Then, under AI:\n\n' +
      fenced(error)
    );
  }
  if (body !== undefined) {
    return `${opening}\n\n${body}\n\n${fenced(error)}`;
  }
  return `${opening}\n\n${fenced(error)}`;
}
