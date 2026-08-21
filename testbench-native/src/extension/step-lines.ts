/**
 * Find the 1-based line numbers of every numbered step under a `## Steps`
 * heading. Mirrors the webview's step-lines-inline.js so the extension
 * doesn't depend on webview source — same regex rules, same scope.
 *
 * A line is a step line iff:
 *   - it lives under a `## Steps` (or deeper) heading, before the next
 *     same-or-shallower heading
 *   - it matches `^\s*\d+\.\s+\S` (numbered list item with content)
 */
const STEPS_HEADING_RE = /^(#{2,})\s+steps\s*$/i;
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;
const STEP_LINE_RE = /^\s*\d+\.\s+\S/;

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

/** True when some change in the event replaces content on the anchor's own
 *  line — i.e. the snap-forward branch will run, so the caller must supply the
 *  post-edit step lines. Mirrors the classification in `shiftAnchorForChanges`
 *  so the two never disagree about whether a touch occurred. */
export function changesTouchAnchor(
  changes: ReadonlyArray<AnchorChange>,
  anchorLine: number,
): boolean {
  return changes.some((c) => c.startLine <= anchorLine && anchorLine <= effectiveEndLine(c));
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

export function extractStepLineIds(text: string): number[] {
  const lines = text.split(/\r?\n/);
  const span = findStepsSpan(lines);
  if (!span) return [];
  const out: number[] = [];
  for (let i = span.start; i <= span.end; i++) {
    if (STEP_LINE_RE.test(lines[i] || '')) out.push(i + 1);
  }
  return out;
}

export function findStepsHeadingLine(text: string): number | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (STEPS_HEADING_RE.test(lines[i] || '')) return i + 1;
  }
  return null;
}

function findStepsSpan(lines: string[]): { start: number; end: number } | null {
  let headingIndex = -1;
  let headingDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = STEPS_HEADING_RE.exec(lines[i] || '');
    if (m) {
      headingIndex = i;
      headingDepth = m[1]!.length;
      break;
    }
  }
  if (headingIndex < 0) return null;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const m = ANY_HEADING_RE.exec(lines[i] || '');
    if (m && m[1]!.length <= headingDepth) {
      return { start: headingIndex + 1, end: i - 1 };
    }
  }
  return { start: headingIndex + 1, end: lines.length - 1 };
}
