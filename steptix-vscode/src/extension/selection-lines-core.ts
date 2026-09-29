/**
 * Which lines a set of editor selections actually names — pure, no VS Code
 * dependency, so the fast `node --test` suite can pin the rules.
 *
 * Extracted from `active-file-tracker.ts`'s `selectionLines`, which feeds
 * `runSelected`, the panel's `snapshot.selectedLines` fallback and (from
 * stories/data-row-progress-and-selection.md) the split of a selection into
 * step lines and data rows. All three want the same answer, and the answer is
 * not "every line the range touches".
 */

/** The shape of a `vscode.Selection` this module needs. Structural on
 *  purpose: the tests build plain objects, the tracker passes the real thing. */
export interface SelectionLike {
  isEmpty: boolean;
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/**
 * 1-based line numbers covered by every *range* selection, sorted and
 * de-duplicated.
 *
 * Two rules, and each exists because of a bug it prevents:
 *
 *  - **Cursor-only selections are ignored.** They mean "I'm parked here", not
 *    "run this." Treating a cursor as a single-line selection caused
 *    empty-trim bugs when the cursor sat on a step that also had a breakpoint
 *    (e.g. after a reload mid-pause): the trimmed run was empty, the pause
 *    indicator went up immediately, and the user thought their test had
 *    silently jumped to the breakpoint without running the preceding steps.
 *
 *  - **A selection ending at column 0 of a later line does not include that
 *    line.** Every whole-line gesture — triple-click, Ctrl+L, Shift+Down from
 *    column 0 — swallows the trailing line break and so ends at column 0 of
 *    the *next* line. Taking that line at face value meant triple-clicking
 *    step 2 ran steps 2 *and* 3, and triple-clicking a table row selected the
 *    row below it too. A selection that ends past column 0 keeps its end
 *    line, as it always has (decision 10).
 *
 * The second rule cannot swallow the whole selection: the guard fires only
 * when the end line is *later* than the start line, so a range that begins
 * and ends on one line always yields that line.
 *
 * …and it has one exception, `runnableLines`, which exists because the guard
 * and `resolveRunSelection`'s last fallback amplify each other. A drag from a
 * blank or prose line that stops at the START of a step used to name that step
 * (`[5, 6]` → "run step 6"). Drop the 6 and the selection names no runnable
 * line at all, so the fallback — "every main-flow step at or below the lowest
 * selected line", which is what makes "drag over `## Steps`, then Run" run the
 * file — takes over and runs step 6 *and everything after it*. Narrowing a
 * selection must not widen a run. So when the line the guard would drop is
 * itself runnable and nothing else in the selection is, it is kept: the
 * gesture named one thing, and that thing is it.
 *
 * Triple-click on a step is unaffected — the line it swallows is the NEXT
 * step, and the line it keeps is a step too, so the exception does not fire.
 */
export function selectionLinesFrom(
  selections: readonly SelectionLike[],
  /**
   * 1-based lines a run can actually name — step lines and data-row lines.
   * Omitted by callers that only want the plain rules (and by every test of
   * them); `selectionLines` in `active-file-tracker.ts` supplies the real set.
   */
  runnableLines?: Iterable<number>,
): number[] {
  const runnable = runnableLines === undefined ? null : new Set(runnableLines);
  const set = new Set<number>();
  for (const sel of selections) {
    if (sel.isEmpty) continue;
    const start = sel.start.line;
    let end = sel.end.line;
    if (end > start && sel.end.character === 0) {
      // 1-based, as `runnable` is.
      const dropped = end + 1;
      const keptNamesSomething =
        runnable !== null &&
        rangeHasRunnable(start + 1, end, runnable);
      if (runnable === null || !runnable.has(dropped) || keptNamesSomething) end -= 1;
    }
    for (let i = start; i <= end; i++) set.add(i + 1);
  }
  return [...set].sort((a, b) => a - b);
}

/** Does the 1-based inclusive range `[from, to]` contain a runnable line? */
function rangeHasRunnable(from: number, to: number, runnable: ReadonlySet<number>): boolean {
  for (let line = from; line <= to; line++) {
    if (runnable.has(line)) return true;
  }
  return false;
}
