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
  | 'pass-cached'
  | 'pass-code-behind'
  | 'pass-stale'
  | 'fail'
  | 'skip'
  | 'stopped';

/** What the heading says, as numbers. */
export interface StepsSummaryCounts {
  passed: number;
  passedCached: number;
  /** Passed by running compiled code — no model call. */
  passedCodeBehind: number;
  /** Passed under AI after the compiled entry threw. */
  stale: number;
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
): StepsSummaryCounts {
  const mainFlow = new Set(mainFlowLines);
  const count = (...wanted: StepLineStatus[]): number =>
    statuses.filter(([line, status]) => wanted.includes(status) && mainFlow.has(line)).length;
  // Every 'pass*' counts as passed — a cache hit, a code-behind entry and a
  // step that healed under AI are all successful steps. What differs is what
  // it cost and whether it needs attention, which is what the breakdown says.
  return {
    passed: count('pass', 'pass-cached', 'pass-code-behind', 'pass-stale'),
    passedCached: count('pass-cached'),
    passedCodeBehind: count('pass-code-behind'),
    stale: count('pass-stale'),
    skipped: count('skip'),
    total: mainFlowLines.length,
  };
}

/**
 * The after-text itself.
 *
 * "12/12 passed (7 code-behind, 1 stale, 2 cached)" — one parenthesis listing
 * only what actually happened, so an ordinary all-AI run reads exactly as it
 * did before any of these features existed. The parenthesis breaks down the
 * PASSES; a skip is not one, so it is its own clause after it, and it appears
 * only when a step was actually skipped. Every run that skipped nothing —
 * which is every run this feature did not touch — renders the byte-identical
 * string it always did.
 */
export function stepsSummaryText(counts: StepsSummaryCounts): string {
  const notes = [
    counts.passedCodeBehind > 0 ? `${counts.passedCodeBehind} code-behind` : '',
    counts.stale > 0 ? `${counts.stale} stale` : '',
    counts.passedCached > 0 ? `${counts.passedCached} cached` : '',
  ].filter((n) => n !== '');
  const head =
    notes.length > 0
      ? `${counts.passed}/${counts.total} passed (${notes.join(', ')})`
      : `${counts.passed}/${counts.total} passed`;
  return counts.skipped > 0 ? `${head}, ${counts.skipped} skipped` : head;
}
