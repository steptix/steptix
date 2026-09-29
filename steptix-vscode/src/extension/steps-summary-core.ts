/**
 * The `## Steps` heading summary — "11/12 passed (7 code-behind), 1 skipped".
 *
 * Pure counting and pure wording, no VS Code dependency, so the fast
 * `node --test` suite can pin both — the same split `failure-hover-core.ts`,
 * `row-summary-core.ts` and `step-skip-core.ts` are on, and for the same
 * reason: an after-text decoration cannot be read back out of the extension
 * host once it is rendered, so if this suite does not pin the string, nothing
 * does.
 *
 * `decorations.ts` keeps `computeStepsSummary`, which is the part that needs a
 * snapshot (and therefore the step extractor); everything it does with the
 * statuses once it has the main-flow lines lives here.
 */

/** The statuses a step line can wear. Mirrors `LineStatus` in
 *  active-file-tracker.ts, as a plain string so this module imports nothing. */
export type StepLineStatus =
  | 'running'
  | 'pass'
  | 'pass-code-behind'
  | 'pass-stale'
  | 'fail'
  | 'fail-tolerated'
  | 'skip'
  | 'stopped';

/** What the heading says, as numbers. */
export interface StepsSummaryCounts {
  passed: number;
  /** Passed by running compiled code — no model call. */
  passedCodeBehind: number;
  /** Passed under AI after the compiled entry threw. PASSES only — a ⚠ on a
   *  line that did not run is {@link staleSkipped}. */
  stale: number;
  /**
   * Of {@link skipped}, the lines that wear ⚠: a chain member whose
   * CONDITION's compiled code threw on the visit that then took another member
   * (stories/codebehind-loops-and-conditions.md). The line did not run, so it
   * is a skip; its entry is broken, so it is stale. Said beside the skip —
   * `1 skipped (1 stale)` — because the parenthesis after a count breaks down
   * THAT count, and the one after `passed` must not claim a line that never ran.
   */
  staleSkipped: number;
  /**
   * Steps a return left unrun (stories/step-flow-control.md, decision 15).
   *
   * Counted apart from `passed` because it is not one, and said apart from it
   * because the denominator would otherwise account for it silently: a run
   * that returned reads `4/5 passed` with nothing anywhere saying where the
   * fifth step went, which looks exactly like a step that quietly failed to
   * paint. The header counts passed, failed and skipped separately for the
   * same reason the report does.
   */
  skipped: number;
  /**
   * Steps that failed and the run carried on past — an `otherwise continue`
   * tail (stories/step-failure-outcomes.md, decision 6).
   *
   * Counted apart from BOTH neighbours, which is the point. Not a pass: the step
   * did not do what it said, and folding it into the numerator would put a green
   * count over work that did not happen. Not a failure either, as far as this line
   * goes: the run went on and is not red for it. Said out loud for the reason
   * `skipped` is — the denominator would otherwise account for it silently.
   */
  tolerated: number;
  total: number;
}

/**
 * Count one snapshot's main-flow statuses.
 *
 * MAIN-FLOW only, and that is the whole point of the function: `total` is the
 * author's own step count, and a body line can run zero times (never invoked)
 * or many (invoked repeatedly), so counting body lines makes the denominator
 * meaningless and lets the numerator exceed it.
 *
 * `statuses` is the snapshot's line→status list; `mainFlowLines` the lines
 * `extractSteps` found under `## Steps`.
 */
export function countMainFlowStatuses(
  statuses: ReadonlyArray<readonly [number, StepLineStatus]>,
  mainFlowLines: readonly number[],
  /**
   * ⚠ lines that did NOT run — a chain member whose condition's code threw on
   * the visit that took another member (the detail's `notTaken`). The ⚠ is
   * there to offer Repair; the step was still skipped, so it is counted
   * skipped (and stale), never passed.
   */
  notTakenLines: ReadonlySet<number> = new Set(),
): StepsSummaryCounts {
  const mainFlow = new Set(mainFlowLines);
  const count = (...wanted: StepLineStatus[]): number =>
    statuses.filter(([line, status]) => wanted.includes(status) && mainFlow.has(line)).length;
  const staleNotTaken = statuses.filter(
    ([line, status]) => status === 'pass-stale' && mainFlow.has(line) && notTakenLines.has(line),
  ).length;
  // Every 'pass*' counts as passed — a step the AI drove, a code-behind entry
  // and a step that healed under AI are all successful steps. What differs is
  // what it cost and whether it needs attention, which is what the breakdown
  // says.
  return {
    passed: count('pass', 'pass-code-behind', 'pass-stale') - staleNotTaken,
    passedCodeBehind: count('pass-code-behind'),
    stale: count('pass-stale') - staleNotTaken,
    skipped: count('skip') + staleNotTaken,
    staleSkipped: staleNotTaken,
    tolerated: count('fail-tolerated'),
    total: mainFlowLines.length,
  };
}

/**
 * The after-text itself.
 *
 * "12/12 passed (7 code-behind, 1 stale)" — one parenthesis listing
 * only what actually happened, so an ordinary all-AI run reads exactly as it
 * did before any of these features existed. The parenthesis breaks down the
 * PASSES; a skip is not one, so it is its own clause after it, and it appears
 * only when a step was actually skipped. Every run that skipped nothing —
 * which is every run this feature did not touch — renders the byte-identical
 * string it always did.
 *
 * `, 1 tolerated` is a second such clause, on the same terms
 * (stories/step-failure-outcomes.md, decision 6): outside the parenthesis
 * because a tolerated failure is not a pass, and present only when there was
 * one, so nothing else's rendering moves.
 *
 * A skip can have a parenthesis of its own, on the same rule — it breaks down
 * the count it follows: `2/3 passed, 1 skipped (1 stale)` for a skipped line
 * wearing ⚠ (its condition's code threw on the visit that took another
 * member). Every run with no such line renders exactly as before.
 */
export function stepsSummaryText(counts: StepsSummaryCounts): string {
  const notes = [
    counts.passedCodeBehind > 0 ? `${counts.passedCodeBehind} code-behind` : '',
    counts.stale > 0 ? `${counts.stale} stale` : '',
  ].filter((n) => n !== '');
  const head =
    notes.length > 0
      ? `${counts.passed}/${counts.total} passed (${notes.join(', ')})`
      : `${counts.passed}/${counts.total} passed`;
  const clauses = [
    counts.skipped > 0 ? `${counts.skipped} skipped${staleSkipNote(counts.staleSkipped)}` : '',
    counts.tolerated > 0 ? `${counts.tolerated} tolerated` : '',
  ].filter((c) => c !== '');
  return clauses.length > 0 ? `${head}, ${clauses.join(', ')}` : head;
}

/** ` (1 stale)` after a skip count, or nothing — both tallies' wording. */
function staleSkipNote(staleSkipped: number | undefined): string {
  return staleSkipped !== undefined && staleSkipped > 0 ? ` (${staleSkipped} stale)` : '';
}

/** What the interactive run log's closing tally counts. */
export interface RunLogTallyCounts {
  /** Steps that EXECUTED and passed — never a skip. */
  passed: number;
  /**
   * Steps that never ran, from BOTH producers: `step:skip`, and `step:pass`
   * carrying `output: 'skipped'`.
   *
   * One accounting rule across every surface. The run log used to fold this
   * into `passed` — the panel header beside it said `✓ 9 passed  ◌ 3 skipped`
   * for the same run while the log said `✓ 12 passed`, and a green tally that
   * includes steps that never ran is the failure direction this codebase
   * names as worst.
   */
  skipped: number;
  /**
   * Steps that failed and the run carried on (`otherwise continue`). Neither a pass
   * nor a failure here, exactly as in {@link StepsSummaryCounts}: a run whose only
   * failures were tolerated ends green, and the tally is the only place the log says
   * so once the per-step lines have scrolled.
   */
  tolerated: number;
  codeBehind: number;
  /** Stale PASSES — healed under AI. */
  stale: number;
  /** Of `skipped`, the ⚠ lines: see {@link StepsSummaryCounts.staleSkipped}.
   *  Optional, so a caller that never sees one reads as it always did. */
  staleSkipped?: number;
}

/**
 * The interactive run log's closing line — `✓ 9 passed (2 code-behind), 3
 * skipped`.
 *
 * Its own function so `node --test` can pin it: the loop that builds it lives
 * inside `run-controller.ts`, which imports `vscode` and is unreachable from
 * this suite. Shaped deliberately like {@link stepsSummaryText}, minus the
 * denominator the log has no snapshot to supply — the parenthesis breaks down
 * the PASSES, and a skip is not one, so it is its own clause after it and
 * appears only when something was actually skipped. A run that skipped nothing
 * renders the byte-identical string it always did.
 */
export function runLogTallyLine(counts: RunLogTallyCounts): string {
  const notes = [
    counts.codeBehind > 0 ? `${counts.codeBehind} code-behind` : '',
    counts.stale > 0 ? `${counts.stale} stale` : '',
  ].filter((n) => n !== '');
  const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';
  const clauses = [
    counts.skipped > 0 ? `${counts.skipped} skipped${staleSkipNote(counts.staleSkipped)}` : '',
    counts.tolerated > 0 ? `${counts.tolerated} tolerated` : '',
  ].filter((c) => c !== '');
  const tail = clauses.length > 0 ? `, ${clauses.join(', ')}` : '';
  return `✓ ${counts.passed} passed${suffix}${tail}`;
}

/**
 * The lines the run log prints under its tally when an entry broke — what it
 * cost, and what to do about it.
 *
 * Naming the price is the point, not decoration: the count alone reads as a
 * one-off, and it is not — the entry is still broken, so the same AI turns are
 * paid on every run until someone repairs it. `cost` is ` (1.2k tokens)`, or
 * empty when the server did not attribute them.
 *
 * A skipped ⚠ counts here too (`staleSkipped`): nothing healed on its line —
 * it did not run — but its CONDITION's code broke and the model decided in its
 * place, which is the same bill and the same Repair. With none, the two lines
 * are exactly what they always were.
 */
export function runLogHealLines(
  counts: { stale: number; staleSkipped?: number | undefined },
  cost: string,
): string[] {
  const skipped = counts.staleSkipped ?? 0;
  if (counts.stale === 0 && skipped === 0) return [];
  const repair = '  Repair this step from the ⚠ gutter, or it costs that again every run.';
  if (skipped === 0) {
    return [`  ${counts.stale} step(s) healed under AI because their code-behind failed${cost}.`, repair];
  }
  return [
    ...(counts.stale > 0
      ? [`  ${counts.stale} step(s) healed under AI because their code-behind failed${cost}.`]
      : []),
    `  ${skipped} condition(s) whose code-behind failed were decided by the model instead` +
      `${counts.stale > 0 ? '' : cost}.`,
    repair,
  ];
}
