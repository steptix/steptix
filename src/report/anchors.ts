/**
 * The id a step card carries in the HTML report, so a scoreboard line can link
 * to the step it describes (docs/specs/SPEC-scoreboard.md §8.3):
 *
 *     step-11                        an ordinary step
 *     row-3-step-11                  the same step, in row 3 of a data-row report
 *     hook-beforeEach-2-step-11      the 2nd line of a hook scope — every line of
 *                                    a scope shares the number of the step it
 *                                    runs beside (0 for `before`), so its place
 *                                    in the scope is what tells them apart
 *     row-3-hook-before-1-step-0     …in row 3
 *     hook-before-step-0             a hook step that does not know its place
 *                                    (a report or a line written before it)
 *
 * Built from exactly what a step line records — `step`, `row`, `hook` and
 * `hookIndex` — so a reader of the lines (`steptix stats --failures`) builds the
 * id the report rendered without opening the report.
 *
 * One id can still fit several cards: a loop body runs its steps once per
 * pass. The report gives the canonical id to the FIRST such card and `-2`,
 * `-3`… to the later ones, so ids stay unique and a link lands on the step's
 * first occurrence.
 *
 * No imports, on purpose: the report generator and the scoreboard's reader
 * both use it, and neither should pull the other in to get a string.
 */
export interface StepAnchorFields {
  /** The step number the report shows (`StepResult.index`). */
  step: number;
  /** The data row, 1-based, in a data-row report. */
  row?: number | undefined;
  /** The hook scope, for a hook's step. */
  hook?: string | undefined;
  /** The hook step's place in its scope, 1-based. Read only with `hook`. */
  hookIndex?: number | undefined;
}

export function stepAnchor(at: StepAnchorFields): string {
  const row = at.row !== undefined ? `row-${at.row}-` : '';
  const hook =
    at.hook === undefined
      ? ''
      : at.hookIndex !== undefined
        ? `hook-${at.hook}-${at.hookIndex}-`
        : `hook-${at.hook}-`;
  return `${row}${hook}step-${at.step}`;
}
