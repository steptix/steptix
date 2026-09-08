/**
 * What a skipped step looks like on the client
 * (stories/step-flow-control.md, decision 9; stories/control-flow.md
 * §"Painting, frames and the report").
 *
 * Pure string + precedence logic, no VS Code dependency, so the fast
 * `node --test` suite can pin it — the same split `failure-hover-core.ts` and
 * `row-summary-core.ts` are on. A skipped step's whole user-visible surface is
 * a glyph, a hover and two log lines, and none of those can be read back out
 * of the extension host once they are rendered.
 *
 * **Two producers, one presentation.** A skipped step reaches the client two
 * ways, and both are load-bearing:
 *
 *  - `step:skip`, with a `line` and a `reason` — what a `return` leaves
 *    behind, and the fuller of the two;
 *  - `step:pass` carrying `output: 'skipped'`, read by `isSkippedPass` — the
 *    older convention, which the untaken half of a chain, a loop body that
 *    never ran and an unattended `[input:]` inside a section body still
 *    arrive on. It carries no reason, because that event shape has no field
 *    for one.
 *
 * They are not merged into one event, and the reason is the deployment shape
 * rather than taste: the extension is an HTTP client of whichever server the
 * workspace points at, so a client that stopped reading the old convention
 * would start painting the untaken branch GREEN the moment it met a server
 * that had not been restarted. What IS merged is everything below this line —
 * one glyph, one precedence rule, one sentence — so the two producers cannot
 * drift into two vocabularies for the same event. That had already happened
 * once: one path said `— step 12 skipped` and the other `◌ step 12 skipped —
 * …`, in adjacent branches of the same `if`.
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
 * The reason clause, or nothing.
 *
 * `step:pass` + `output: 'skipped'` has no reason field, so the sentence has
 * to read without one — and it does, because the glyph and the word already
 * say what happened. Blank and whitespace-only are treated as absent so a
 * server that sends an empty string cannot produce a trailing dash.
 */
function because(reason?: string): string {
  const trimmed = reason?.trim();
  return trimmed ? ` — ${trimmed}` : '';
}

/**
 * The interactive run log's line — the surface `✓ step 12 passed` and
 * `✗ step 12 failed: …` share (run-controller.ts).
 */
export function skipRunLogLine(line: number, reason?: string): string {
  return `${SKIP_GLYPH} step ${line} skipped${because(reason)}`;
}

/**
 * The compile log's line, indented under its phase and addressing the step by
 * source line the way the `✓ step on line 12` beside it does.
 */
export function skipCompileLogLine(line: number, reason?: string): string {
  return `${SKIP_GLYPH} step on line ${line} skipped${because(reason)}`;
}

/**
 * The Runner PANEL's line (the webview), which addresses a step by source line
 * and capitalises it the way `✓ Step on line 12 passed` beside it does.
 *
 * Mirrored into `src/webview/lib/failure-text-inline.js` — the webview cannot
 * import this module, for the Vite CJS-interop reason that file's docstring
 * gives — and pinned by `tests/failure-text-copy-parity.test.js`.
 */
export function skipPanelLine(line: number, reason?: string): string {
  return `${SKIP_GLYPH} Step on line ${line} skipped${because(reason)}`;
}

/**
 * Test Explorer's streamed line, which names the FILE as well when the step
 * is not in the test being run (`where` is the ` of login.md` suffix
 * `whereOf` builds). Same vocabulary as the run log, same shape as the
 * `✓ step on line 12 of login.md passed` beside it.
 */
export function skipTestOutputLine(line: number, where: string, reason?: string): string {
  return `${SKIP_GLYPH} step on line ${line}${where} skipped${because(reason)}`;
}
