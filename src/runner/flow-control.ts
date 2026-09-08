/**
 * "The rest of the flow this step is in" — the one computation every runner
 * needs once a step returns (stories/step-flow-control.md §"Shared runner
 * helper").
 *
 * Nothing new is parsed to know where a section ends. A test is expanded at
 * parse time into one flat list, each step carries the id of the FRAME it runs
 * in, and every frame records its parent (`ExpandedStepOrigin` / `ExpandedFrame`
 * in src/skills/expander.ts). So from step `i` in frame `F`, the steps a return
 * leaves behind are every later step whose frame is `F` or a descendant of it,
 * up to the first step that is not.
 *
 * Four loops act on that answer — the CLI runner, the Sessions API server, the
 * Electron Runner UI and the MCP errand runner — and they must agree to the
 * index and to the character. Hence one module rather than four
 * reimplementations, including the reason strings: a report and a wire event
 * describing the same skipped step in different words is a bug nobody would
 * notice until they were compared.
 */
import type { ExpandedFrame, ExpandedStepOrigin } from '../skills/expander.js';
import type { StepResult } from '../report/types.js';

/** The frame table as the helpers read it — the shape `ParsedTest.expansion`
 *  and the server's session state both hold. */
export type FrameTable = Readonly<Record<string, ExpandedFrame>>;

/**
 * How deep a frame chain may be before the walk gives up.
 *
 * The expander caps nesting at 10 and cannot emit a cycle, so this can only
 * fire on a corrupted table shipped over the wire. It exists because the
 * alternative failure is an infinite loop inside a run.
 */
const MAX_FRAME_DEPTH = 64;

/** The root frame's id — the main flow of the test. Frames record it as
 *  `parentId: null`, and origins as `frameId: ''`; both mean the same place. */
const ROOT = '';

/**
 * True when `candidate` is `ancestor` itself or sits anywhere beneath it.
 *
 * The walk is over `parentId`, which is `null` on a frame whose parent is the
 * root — so the chain ends at the root without the root ever being a named
 * ancestor. That is what stops a section's exit index running to the end of
 * the test.
 */
function isSelfOrDescendant(candidate: string, ancestor: string, frames: FrameTable): boolean {
  let id = candidate;
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth++) {
    if (id === ancestor) return true;
    if (id === ROOT) return false;
    const frame = frames[id];
    // An id with no frame is not a frame we can climb out of. Treating it as
    // root is the same fallback `frameExitIndex` takes for a missing
    // expansion: the safe direction is "not in this frame", which skips fewer
    // steps rather than more.
    if (!frame) return false;
    id = frame.parentId ?? ROOT;
  }
  return false;
}

/**
 * The last expanded index (INCLUSIVE) of the flow step `i` runs in: `i`'s own
 * frame or any descendant of it.
 *
 * `stepCount - 1` for the root frame — a main-flow return ends the test — and
 * for any runner with no expansion at all (the raw `parseTestContent` path,
 * MCP errands), which treats every step as root by the same rule.
 *
 * Returns `i` itself when the returning step is the last of its frame, so a
 * caller that skips `(i, exit]` skips nothing and needs no special case.
 *
 * `stepCount` is the length of the expanded step list. It is a parameter
 * rather than `origins.length` because the no-expansion callers have no
 * origins to take it from, and the answer for them is precisely "to the end".
 */
export function frameExitIndex(
  origins: readonly ExpandedStepOrigin[] | undefined,
  frames: FrameTable | undefined,
  i: number,
  stepCount: number,
): number {
  const total = origins && origins.length > 0 ? origins.length : stepCount;
  const last = total - 1;
  if (!origins || !frames) return last;

  const frameId = origins[i]?.frameId ?? ROOT;
  // The root frame, or a frame id the table does not know: both mean "the
  // flow this step is in is the whole run".
  if (frameId === ROOT || !frames[frameId]) return last;

  let exit = i;
  while (exit + 1 <= last && isSelfOrDescendant(origins[exit + 1]?.frameId ?? ROOT, frameId, frames)) {
    exit++;
  }
  return exit;
}

/**
 * What to call the flow in a reason string: the section or skill name, or
 * null when the step is in the main flow.
 *
 * `ExpandedFrame.skillName` carries the section name for a `section` frame —
 * the field is reused, see its doc comment in expander.ts — so one read
 * answers for both kinds. A looped iteration is NOT labelled `(2/3)` here:
 * the reason says which step returned, and the iteration is already visible
 * from the report's loop band and the frame events.
 */
export function frameLabel(
  origins: readonly ExpandedStepOrigin[] | undefined,
  frames: FrameTable | undefined,
  i: number,
): string | null {
  if (!origins || !frames) return null;
  const frameId = origins[i]?.frameId ?? ROOT;
  if (frameId === ROOT) return null;
  return frames[frameId]?.skillName ?? null;
}

/**
 * The explanation a returning step carries, and the prefix of every reason
 * string built from it (story decision 3 and 4).
 *
 * One formatter for four loops, so `Returned from "Sign in"` cannot become
 * `returned from Sign in` on one path. `detail` is the model's own description
 * of why it returned, when there was a model turn; the unconditional form has
 * none and reads as the bare phrase.
 */
export function flowControlExplanation(label: string | null, detail?: string): string {
  const lead = label === null ? 'Ended the run' : `Returned from "${label}"`;
  const extra = detail?.trim();
  return extra ? `${lead}: ${extra}` : lead;
}

/**
 * A `skipped` StepResult for expanded step `j`, naming step `i` as the cause.
 *
 * Both indices are 0-based expanded indices, as the loops hold them; the
 * result's own `index` is 1-based like every other StepResult, and the
 * message names step `i + 1` for the same reason.
 *
 * No turns, no screenshot, no duration: a skipped step spent nothing. It is
 * `status: 'skipped'` rather than a passed step with a note, because the
 * failure direction this codebase treats as worst is a green report for work
 * that did not happen.
 */
export function skippedByReturn(
  j: number,
  instruction: string,
  i: number,
  label: string | null,
  returningStepText: string,
): StepResult {
  return {
    index: j + 1,
    instruction,
    status: 'skipped',
    turns: [],
    durationMs: 0,
    retried: false,
    aiExplanation: skippedByReturnReason(i, label, returningStepText),
  };
}

/**
 * How much of the returning step's own line rides along on a reason string.
 *
 * Long enough that a realistic `If … then stop running the remaining steps`
 * survives whole, short enough that a gutter hover, a log line and a report
 * cell all stay one line.
 */
const RETURNING_TEXT_LIMIT = 80;

/** The returning step's authored line, clipped to `RETURNING_TEXT_LIMIT`
 *  characters INCLUDING the ellipsis, so the reason has a fixed ceiling. */
function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > RETURNING_TEXT_LIMIT
    ? `${trimmed.slice(0, RETURNING_TEXT_LIMIT - 1)}…`
    : trimmed;
}

/**
 * The reason text alone — `Not run: step 3 returned from "Sign in" — If the
 * page title contains "Dashboard" then return`.
 *
 * Exported because the wire carries it as `StepSkipEvent.reason` where there
 * is no `StepResult` to take it off (story decision 9), and the two must be
 * the same sentence.
 *
 * Two halves, and each answers a different reader. `step N` is the EXPANDED
 * index, which is what the report rows and the server's run log are numbered
 * by ("Step 7/13"), so those two can be read together. But the editor is
 * numbered by nothing of the sort: a hover on a section body line saying
 * "step 7 returned" names a step the author cannot see, because the section
 * they are looking at has five lines in it. So the returning step's AUTHORED
 * text is appended, and that is findable anywhere — in the file, in the log,
 * in the report.
 *
 * AUTHORED, never interpolated: a `[skill: …]` argument or a `{{password}}`
 * resolves to a literal value, and a reason string is written to a run log, an
 * HTML report and a wire event. The authored form cannot leak one.
 */
export function skippedByReturnReason(
  i: number,
  label: string | null,
  returningStepText: string,
): string {
  const lead =
    label === null
      ? `Not run: step ${i + 1} ended the run`
      : `Not run: step ${i + 1} returned from "${label}"`;
  const text = clip(returningStepText);
  return text ? `${lead} — ${text}` : lead;
}
