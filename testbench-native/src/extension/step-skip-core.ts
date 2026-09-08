/**
 * What a `step:skip` looks like on the client
 * (stories/step-flow-control.md, decision 9).
 *
 * Pure string + precedence logic, no VS Code dependency, so the fast
 * `node --test` suite can pin it — the same split `failure-hover-core.ts` and
 * `row-summary-core.ts` are on. A skipped step's whole user-visible surface is
 * a glyph, a hover and two log lines, and none of those can be read back out
 * of the extension host once they are rendered.
 */

/**
 * The mark a line that never ran wears — a hollow circle, the same drawing as
 * the gutter's `status-skip.svg` and the same glyph the Rows panel already
 * uses for a row the loop never reached. One shape for "planned, not run",
 * wherever it is said.
 */
export const SKIP_GLYPH = '◌';

/**
 * May a `step:skip` paint over what the line already wears?
 *
 * Everything except a ✗. A return skips the REST of its flow, so the lines it
 * names have normally either passed on an earlier pass through the same body
 * (a section called twice) or carry nothing at all — and overwriting a pass
 * with ◌ is right, because the second call genuinely did not run them.
 *
 * A ✗ is the exception, and the reason this is a function rather than an
 * unconditional write: a failure is the one status a run must not lose. It
 * also cannot be stale — the statuses are cleared at run start — so a ✗ under
 * an incoming skip is this run's, and downgrading it would turn a red run into
 * a quiet one.
 */
export function skipPaintsOver(current: string | undefined): boolean {
  return current !== 'fail';
}

/**
 * The interactive run log's line — the surface `✓ step 12 passed` and
 * `✗ step 12 failed: …` share (run-controller.ts).
 */
export function skipRunLogLine(line: number, reason: string): string {
  return `${SKIP_GLYPH} step ${line} skipped — ${reason}`;
}

/**
 * Test Explorer's streamed line, which names the FILE as well when the step
 * is not in the test being run (`where` is the ` of login.md` suffix
 * `whereOf` builds). Same vocabulary as the run log, same shape as the
 * `✓ step on line 12 of login.md passed` beside it.
 */
export function skipTestOutputLine(line: number, where: string, reason: string): string {
  return `${SKIP_GLYPH} step on line ${line}${where} skipped — ${reason}`;
}
