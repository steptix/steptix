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
 * pass, and a `beforeEach` runs beside every pass of it. The report gives
 * this id to the FIRST such card and `-2`, `-3`… to the later ones, so ids
 * stay unique; {@link stepCardIds} assigns them. A scoreboard line knows only
 * these fields, so its link lands on the step's first card.
 *
 * No imports, on purpose: the report generator, the scoreboard's reader and
 * the `junit.xml` / `run.json` writers all use it, and none should pull
 * another in to get a string.
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

/**
 * What {@link stepCardIds} reads of a step: the `StepResult` fields it needs,
 * written out here so this file imports nothing.
 */
export interface StepCardFields {
  index: number;
  instruction: string;
  dataRow?: number | undefined;
  loop?: { kind: string; index: number } | undefined;
  hookScope?: string | undefined;
  hookIndex?: number | undefined;
  interactiveChild?: boolean | undefined;
}

/** An `[interactive]` step, whose card is a banner with its typed commands under it. */
export const INTERACTIVE_PROMPT = /^\[interactive\]\s*(.*)$/i;

/**
 * The {@link stepAnchor} of a step, from its own fields: its number, its data
 * row (`dataRow`, else a run row's loop marker) and its hook scope.
 */
export function canonicalStepAnchor(step: StepCardFields): string {
  return stepAnchor({
    step: step.index,
    row: step.dataRow ?? (step.loop?.kind === 'row' ? step.loop.index : undefined),
    hook: step.hookScope,
    hookIndex: step.hookIndex,
  });
}

/**
 * The id of every step card one report renders, keyed by the step: the first
 * card to claim a {@link canonicalStepAnchor} keeps it, a later one takes
 * `-2`, `-3`… in the order of `steps`.
 *
 * The one place the ids are assigned. The report generator renders its cards
 * with them and the `junit.xml` / `run.json` writers link to them, so a link
 * to a step that ran more than once lands on the card of the pass it names.
 *
 * A step marked `interactiveChild` has a card only under an `[interactive]`
 * step, in the unbroken run of such steps right after it, which is where the
 * generator draws them; one anywhere else has no card and no id.
 */
export function stepCardIds<S extends StepCardFields>(steps: readonly S[]): Map<S, string> {
  const ids = new Map<S, string>();
  const used = new Map<string, number>();
  let underPrompt = false;
  for (const step of steps) {
    if (step.interactiveChild) {
      if (!underPrompt) continue;
    } else {
      underPrompt = INTERACTIVE_PROMPT.test(step.instruction);
    }
    const id = canonicalStepAnchor(step);
    const seen = used.get(id) ?? 0;
    used.set(id, seen + 1);
    ids.set(step, seen === 0 ? id : `${id}-${seen + 1}`);
  }
  return ids;
}
