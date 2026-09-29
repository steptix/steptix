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
 *    arrive on. It now carries a `reason` too, on a server new enough to send
 *    one; every builder below takes it as optional, which is what keeps an
 *    older server's bare sentence readable.
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
 * A server older than `StepPassEvent.reason` sends none on a `step:pass` skip,
 * so the sentence has to read without one — and it does, because the glyph and
 * the word already say what happened. Blank and whitespace-only are treated as
 * absent so a server that sends an empty string cannot produce a trailing
 * dash.
 *
 * The leading `Skipped:` goes. `skipReasonFor` (src/runner/control-runtime.ts)
 * writes a standalone sentence — "Skipped: another branch of this decision was
 * taken" — because that is what a report CELL holds, and a cell has no glyph
 * beside it. Pasted into this line it stutters: `◌ step 5 skipped — Skipped:
 * another branch…`. Stripped once, here, rather than at each of the four call
 * sites or by rewording the report rows every suite asserts on. A reason that
 * leads with anything else (`Not run: step 3 returned from "Sign in"`) is left
 * exactly as the server wrote it.
 *
 * The colon is optional in the strip because the label arrives without one
 * too: every runner falls back to a bare `'Skipped'` when it has no sentence
 * for a queued row (`skipReasons.get(k) ?? 'Skipped'`), which produced `◌ step
 * 7 skipped — Skipped`. Anchored on a word boundary, so a reason that merely
 * BEGINS with the letters (`Skippedy…`) is not touched, and `The loop was
 * skipped: …` — where the word is mid-sentence — is not either.
 */
function because(reason?: string): string {
  const trimmed = reason?.trim().replace(/^skipped\b\s*:?\s*/i, '');
  return trimmed ? ` — ${trimmed}` : '';
}

/**
 * The gutter ◌'s hover, or nothing.
 *
 * The one place the hover's wording is decided, so the difference from the log
 * lines is deliberate rather than incidental. It KEEPS the leading `Skipped:`
 * that {@link because} strips, because the two surfaces are not the same
 * sentence: a log line already says `◌ step 5 skipped` before the reason
 * reaches it, so repeating the word stutters, while a hover is standalone
 * prose in a box of its own with the glyph in the gutter beside it — the same
 * shape `rowSkipHover` (row-summary-core.ts) gives a data row, which likewise
 * leads with a capitalised clause naming what did not happen.
 *
 * What it does share with the log lines is the blank rule: `undefined`, an
 * empty string and whitespace all mean "no hover", so a server that sends an
 * empty `reason` cannot open an empty hover box on the line.
 */
export function skipHoverMessage(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A skipped line whose CONDITION's compiled code threw on the visit that then
 * took another member — the `step:pass` that carries both `output: 'skipped'`
 * and `codeBehindStale` (stories/codebehind-loops-and-conditions.md, review
 * round 1's R2). The gutter paints it ⚠ and its hover says both facts; every
 * line below says both too, in the same order: the skip, then what the code
 * threw. Without `stale` a line is byte-identical to what it always was.
 */
export interface StaleSkip {
  error: string;
}

/** The glyph a skipped line leads with: ◌, or ⚠ when its condition's code
 *  broke — the mark the gutter beside it wears. */
function glyphOf(stale?: StaleSkip): string {
  return stale ? '⚠' : SKIP_GLYPH;
}

/** The second fact a stale skip carries, or nothing. The words are the
 *  panel's own (`formatStepFailure`'s "condition code-behind failed"). */
function brokenCondition(stale?: StaleSkip): string {
  return stale ? `; condition code-behind failed: ${stale.error}` : '';
}

/**
 * The interactive run log's line — the surface `✓ step 12 passed` and
 * `✗ step 12 failed: …` share (run-controller.ts).
 */
export function skipRunLogLine(line: number, reason?: string, stale?: StaleSkip): string {
  return `${glyphOf(stale)} step ${line} skipped${because(reason)}${brokenCondition(stale)}`;
}

/**
 * The compile log's line, indented under its phase and addressing the step by
 * source line the way the `✓ step on line 12` beside it does.
 */
export function skipCompileLogLine(line: number, reason?: string, stale?: StaleSkip): string {
  return `${glyphOf(stale)} step on line ${line} skipped${because(reason)}${brokenCondition(stale)}`;
}

/**
 * The Runner PANEL's line (the webview), which addresses a step by source line
 * and capitalises it the way `✓ Step on line 12 passed` beside it does.
 *
 * Mirrored into `src/webview/lib/failure-text-inline.js` — the webview cannot
 * import this module, for the Vite CJS-interop reason that file's docstring
 * gives — and pinned by `tests/failure-text-copy-parity.test.js`.
 */
export function skipPanelLine(line: number, reason?: string, stale?: StaleSkip): string {
  return `${glyphOf(stale)} Step on line ${line} skipped${because(reason)}${brokenCondition(stale)}`;
}

/**
 * Test Explorer's streamed line, which names the FILE as well when the step
 * is not in the test being run (`where` is the ` of login.md` suffix
 * `whereOf` builds). Same vocabulary as the run log, same shape as the
 * `✓ step on line 12 of login.md passed` beside it.
 */
export function skipTestOutputLine(line: number, where: string, reason?: string, stale?: StaleSkip): string {
  return `${glyphOf(stale)} step on line ${line}${where} skipped${because(reason)}${brokenCondition(stale)}`;
}
