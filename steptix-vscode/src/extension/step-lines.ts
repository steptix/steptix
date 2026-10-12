/**
 * Step lines for the extension host, and the resume anchor's shift maths.
 *
 * Which lines are steps is runner-core's answer, re-exported here: the gutter,
 * breakpoints and the panel used to read a looser copy of the grammar than the
 * one a run sends, so an indented step showed in the editor and never ran
 * (steptix/steptix#49). What stays in this file is host-only: the anchor maths
 * below, free of any `vscode` dependency so it is unit-testable in isolation.
 */
import { classifyLines } from 'steptix-runner-core';

export { extractStepLineIds } from 'steptix-runner-core';

const STEPS_HEADING_RE = /^(#{2,})\s+steps\s*$/i;

/** One content change from a `TextDocumentChangeEvent`: the 0-based
 *  `startLine`/`endLine` of the replaced range, the range's 0-based
 *  `endCharacter`, plus `addedLines` (count of `\n` in the replacement text). */
export interface AnchorChange {
  startLine: number;
  endLine: number;
  endCharacter: number;
  addedLines: number;
}

/**
 * The last line whose *content* a change actually replaces. A range that ends
 * at column 0 of a line stops before any of that line's content, so it doesn't
 * touch it — the last affected line is the one above. This is what lets
 * "select whole lines above the anchor and paste" (a range ending at column 0
 * of the anchor's line) shift the anchor rather than snap it.
 */
function effectiveEndLine(c: AnchorChange): number {
  return c.endCharacter === 0 ? c.endLine - 1 : c.endLine;
}

/**
 * Pure shift/snap/clear math for the resume position-anchor (see
 * stories/specs/resume-position-anchor.md §4.2). Kept here, free of any
 * `vscode` dependency, so it's unit-testable in isolation — the tracker wires
 * it to a real `TextDocumentChangeEvent`'s changes.
 *
 * Takes ALL of an event's changes at once rather than folding them one at a
 * time, because a single event's changes are reported in the document's
 * *original* coordinates and applied simultaneously. Classifying every change
 * against the original `anchorLine` keeps the shift and the snap in one
 * coordinate space; folding per-change mixed pre- and post-edit coordinates
 * and double-counted an above-anchor shift when the same event also touched
 * the anchor line (multi-cursor edits, file-wide find/replace, formatters).
 *
 * Changes within one event are non-overlapping, so at most one can contain the
 * anchor line. Classification uses `effectiveEndLine` (a range ending at column
 * 0 doesn't touch that line's content), so per change relative to the original
 * anchor:
 *  - entirely ABOVE (`effectiveEndLine < anchorLine`) → contributes its net
 *    line delta. This includes a whole-line selection above the anchor replaced
 *    by fewer lines (e.g. select-and-paste) — the anchor shifts up, it does not
 *    snap.
 *  - entirely BELOW (`startLine > anchorLine`) → no effect;
 *  - TOUCHING (`startLine <= anchorLine <= effectiveEndLine`) → the resume
 *    step's own line was altered or deleted; collapse to the edit's start
 *    (shifted by the edits above it) and snap forward to the first surviving
 *    step at/after it.
 *
 * @param anchorLine  the anchor's current 0-based line
 * @param changes     the event's content changes (any order; non-overlapping)
 * @param stepLines   the post-edit document's step lines, 1-based, ascending
 *                    (as returned by `extractSteps(...).map(s => s.line)`), or
 *                    a function returning them for a given 1-based target
 *                    line. The function form exists for two reasons: it is
 *                    only called when a change actually touches the anchor, so
 *                    plain typing never re-parses the document; and a
 *                    section-body anchor's candidates depend on the target
 *                    line, because it must snap among the body lines of *its
 *                    own* section rather than slide into the next one.
 * @returns the anchor's new 0-based line, or null when no step survives at or
 *          after a touched-line edit (caller clears the anchor)
 */
export function shiftAnchorForChanges(
  anchorLine: number,
  changes: ReadonlyArray<AnchorChange>,
  stepLines: number[] | ((targetLine: number) => number[]),
): number | null {
  let deltaAbove = 0;
  let touchStart: number | null = null;
  for (const change of changes) {
    const { startLine, endLine, addedLines } = change;
    if (effectiveEndLine(change) < anchorLine) {
      // Entirely above (including a whole-line replace ending at column 0 of
      // the anchor line): contribute the net line delta. `removedLines` uses
      // the real endLine — the number of line breaks the range spans.
      deltaAbove += addedLines - (endLine - startLine);
    } else if (startLine > anchorLine) {
      // Below the anchor — no effect.
    } else {
      // Touches the anchor line's content. Non-overlapping changes mean only
      // one can.
      touchStart = startLine;
    }
  }
  if (touchStart === null) {
    return anchorLine + deltaAbove;
  }
  // The resume step's line was edited or deleted. Its start, shifted by the
  // edits above it, is a stable point in the post-edit document; snap from
  // there to the first surviving step at/after it (1-based for stepLines).
  const target = touchStart + deltaAbove + 1;
  const candidates = typeof stepLines === 'function' ? stepLines(target) : stepLines;
  const next = candidates.find((sl) => sl >= target);
  return next === undefined ? null : next - 1;
}

/**
 * 1-based line of the first Steps heading, or null. Frontmatter is skipped, as
 * runner-core skips it when it finds the span the step lines come from — so
 * the heading's decoration and the steps below it name the same span.
 */
export function findStepsHeadingLine(text: string): number | null {
  const lines = text.split(/\r?\n/);
  const kinds = classifyLines(text);
  for (let i = 0; i < lines.length; i++) {
    if (kinds[i]?.kind === 'frontmatter') continue;
    if (STEPS_HEADING_RE.test(lines[i] || '')) return i + 1;
  }
  return null;
}
