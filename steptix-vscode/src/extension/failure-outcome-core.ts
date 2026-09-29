/**
 * What the two failure OUTCOMES look like on the client
 * (stories/step-failure-outcomes.md, decisions 6 and 9).
 *
 * Pure string and precedence logic, no VS Code dependency, so the fast
 * `node --test` suite can pin it — the split `step-skip-core.ts`,
 * `failure-hover-core.ts` and `steps-summary-core.ts` are on, because a gutter
 * decoration and an output-channel line cannot be read back out of the
 * extension host once rendered.
 *
 * Two additive booleans ride the one `step:fail` event:
 *
 *  - `tolerated` — an `otherwise continue` tail. Amber ✗: never green, because
 *    the step did not do its work, and never red, because the run is not red
 *    for it (`done.status` already excludes it, decision 6).
 *  - `deliberate` — the `fail` verb. An ordinary red ✗ with an ordinary hover;
 *    what it buys is a log line saying the failure was ASKED for, so a reader
 *    does not hunt a root cause the author already wrote.
 *
 * A client that knows neither paints a red ✗ and counts a failure, which
 * over-reports rather than under-reports — the safe direction, and the reason
 * both fields are additive rather than a new status on the wire.
 */

/**
 * May a tolerated failure paint over what the line already wears? Everything
 * except a real ✗ — same rule and reason as `skipPaintsOver`
 * (step-skip-core.ts): downgrading a red step to amber would turn a red run
 * into a quiet one. It cannot be stale, since statuses are cleared at run
 * start. Reachable whenever one source line runs more than once: a loop body, a
 * section called twice, a `### Section` re-entered by Continue.
 */
export function toleratedPaintsOver(current: string | undefined): boolean {
  return current !== 'fail';
}

/**
 * May a PASS paint over what the line already wears? Everything except an amber
 * ✗, and this asymmetry is worth stating: a later pass on a line is ordinarily
 * the truth, so a pass has always painted unconditionally — but the whole point
 * of `otherwise continue` is that the run keeps going, so a later pass on the
 * same line is the NORMAL case and repainting green would make the tail
 * invisible on exactly the runs it exists for.
 *
 * A real ✗ is deliberately NOT protected here: that behaviour predates this
 * story (a loop's clean pass does overwrite an earlier red one, and the
 * end-of-loop worst-status repaint puts the red back for data rows).
 */
export function passPaintsOver(current: string | undefined): boolean {
  return current !== 'fail-tolerated';
}

/**
 * The interactive run log's line for a tolerated failure — the sibling of
 * `✗ step 12 failed: …` and `◌ step 12 skipped — …` (run-controller.ts).
 *
 * ⚠ rather than ✗ so the log reads the way the gutter paints, and `— continuing:`
 * because the next line in the log is the next step starting: without the word, a
 * reader who has just seen a failure has to scroll on to learn the run did not
 * stop. `described` is `describeStepFailure(event)`, so a code-behind failure
 * keeps the wording every other single-line surface gives it.
 *
 * `warning` is the author's own sentence when the tail carried one. It LEADS,
 * with the framework's account bracketed after it, because the two answer
 * different questions: `⚠ step 7 failed — continuing: No peanuts on the
 * dashboard (the title did not contain "Peanuts")`. Without it the warning
 * reached no client at all — it travelled only in the row's explanation, which
 * no wire event carries.
 */
export function toleratedRunLogLine(
  line: number,
  described: string,
  warning?: string,
): string {
  const said =
    warning === undefined || warning === '' ? described : `${warning} (${described})`;
  return `⚠ step ${line} failed — continuing: ${said}`;
}

/**
 * The run log's line for a DELIBERATE failure — the `fail` verb. Still a ✗ and
 * still a failure that stopped the run; `as written` is the whole difference,
 * and it is doing work: the text after the colon is the author's own sentence,
 * so a reader who takes it for the framework's diagnostic goes looking for a
 * stack trace that does not exist.
 */
export function deliberateRunLogLine(line: number, described: string): string {
  return `✗ step ${line} failed as written: ${described}`;
}

/**
 * Test Explorer's streamed line, which names the FILE as well when the step is
 * not in the test being run (`where` is the ` of login.md` suffix `whereOf`
 * builds) — the same shape `skipTestOutputLine` has beside it.
 */
export function toleratedTestOutputLine(
  line: number,
  where: string,
  described: string,
): string {
  return `⚠ step on line ${line}${where} failed — continuing: ${described}`;
}

/** Same, for a deliberate failure. */
export function deliberateTestOutputLine(
  line: number,
  where: string,
  described: string,
): string {
  return `✗ step on line ${line}${where} failed as written: ${described}`;
}
