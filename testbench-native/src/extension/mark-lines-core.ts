/**
 * Where a run mark goes when the document is edited under it.
 *
 * The tracker pins every ✓ / ✗ / ◌ / ⚠, the failure detail behind it and the
 * error band to a 1-based line number (active-file-tracker.ts), and the editor
 * repaints from those numbers on every keystroke. A number that does not move
 * with the text paints its mark on whatever slid into the old line: insert a
 * line above step 1 and every mark reads one step early, with the last step's
 * mark on nothing at all.
 *
 * The rule is that a mark follows its line's text:
 *
 *  - an edit that ends at or before the line's start moves it by the lines
 *    that edit added or removed;
 *  - an edit that starts after the line's first character leaves it where it
 *    is — whatever it does further along, this line still begins here;
 *  - an edit confined to the line itself keeps the mark, however much of the
 *    text it rewrote. Fixing a typo, or Renumber Steps rewriting the ordinal,
 *    must not wipe the step's result;
 *  - an edit that takes the line's start AND a line break removes the mark.
 *    Either the line is gone (Ctrl+Shift+K, a multi-line delete) or what is
 *    left of it now continues another line, which already has a start of its
 *    own (Backspace at column 0, Delete at the end of the line above).
 *
 * The last rule is where this parts from the resume arrow
 * (`shiftAnchorForChanges`, step-lines.ts), which snaps forward to the next
 * step when its line is deleted. That is right for a place to resume and
 * wrong for a result: a ✓ that slid onto the next step would say a step
 * passed that has not run since it was written.
 *
 * Pure and `vscode`-free, so the fast suite pins it.
 */

/** One content change from a `TextDocumentChangeEvent`, 0-based, in the
 *  document's coordinates BEFORE the event (VS Code reports every change of
 *  one event against the original text, applied simultaneously). */
export interface MarkChange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  /** `\n` count in the replacement text. */
  addedLines: number;
}

/**
 * The new 0-based line of a mark on 0-based `line`, or null when the event
 * removed the line.
 *
 * Every change is classified against the ORIGINAL `line`, never against a
 * running result, for the reason `shiftAnchorForChanges` gives: one event's
 * changes are simultaneous, and folding them one at a time mixes pre- and
 * post-edit coordinates.
 */
export function shiftMarkLine(line: number, changes: ReadonlyArray<MarkChange>): number | null {
  let delta = 0;
  for (const c of changes) {
    // Ends at or before column 0 of the line: the line's text is untouched
    // and only its position moves. This includes an insertion AT column 0 —
    // pressing Enter there pushes the step down, so its mark goes with it.
    if (c.endLine < line || (c.endLine === line && c.endCharacter === 0)) {
      // …unless the change deleted the line break in front of this line from
      // partway along an earlier line and put none back: Backspace at column
      // 0, Delete at the end of the line above. This line's text now carries
      // on after that line's own, so it no longer starts a line.
      if (
        c.endLine === line &&
        c.startLine < line &&
        c.startCharacter > 0 &&
        c.addedLines === 0
      ) {
        return null;
      }
      delta += c.addedLines - (c.endLine - c.startLine);
      continue;
    }
    // Starts after the line's first character, or on a later line.
    if (c.startLine > line || (c.startLine === line && c.startCharacter > 0)) continue;
    // Covers the line's start. Kept only when it stays inside the line.
    if (c.startLine === line && c.endLine === line) continue;
    return null;
  }
  return line + delta;
}

/**
 * Where each of `lines` (1-based) goes, for the lines that move or are
 * removed; `null` marks a removal. Returns null when nothing moved at all —
 * the common case, a keystroke inside a line — so the caller can skip the
 * rebuild and the repaint.
 *
 * Computed once for the union of every line-keyed store, so a line removed
 * from the statuses is removed from the failure details and the error bands
 * too: deciding per store could leave a ✗ with another step's hover.
 *
 * Two lines landing on one can only happen when an event's adjacent changes
 * join a line on without either change doing it alone (a delete to the end of
 * one line, and a second change deleting the next line whole). The earlier
 * line keeps it: its text comes first, so it is the one that starts the line.
 */
export function markLineMoves(
  lines: Iterable<number>,
  changes: ReadonlyArray<MarkChange>,
): Map<number, number | null> | null {
  const moves = new Map<number, number | null>();
  const taken = new Set<number>();
  for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
    const shifted = shiftMarkLine(line - 1, changes);
    const next = shifted === null ? null : shifted + 1;
    if (next === null || taken.has(next)) {
      moves.set(line, null);
      continue;
    }
    taken.add(next);
    if (next !== line) moves.set(line, next);
  }
  return moves.size > 0 ? moves : null;
}

/**
 * Apply `markLineMoves` to one line-keyed store, in place — callers hold
 * references to these maps, so replacing one would strand them. Lines absent
 * from `moves` stay where they are.
 */
export function moveLineKeyed<V>(
  map: Map<number, V>,
  moves: ReadonlyMap<number, number | null>,
): void {
  const entries = [...map];
  map.clear();
  for (const [line, value] of entries) {
    const next = moves.has(line) ? (moves.get(line) as number | null) : line;
    if (next !== null) map.set(next, value);
  }
}
