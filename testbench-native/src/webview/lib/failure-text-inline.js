/**
 * Failure text for the webview panel.
 *
 * `describeStepFailure` MIRRORS runner-core's function of the same name. The
 * webview can't import runner-core directly because Vite's CJS interop drops
 * named exports through __exportStar (same reason `step-lines-inline.js`
 * exists), so the wording is duplicated here and pinned to the original by
 * `tests/failure-text-copy-parity.test.js`. Change one, change both — a
 * divergence means the Output log and the run log describe the same event in
 * different words.
 *
 * `formatStepFailure` is NOT a mirror: it is the panel's own multi-line block
 * under a step row, which legitimately shows more than a one-line log entry.
 * It reads the same `StepFailureDetail` fields and must agree with them, not
 * with the single-line phrasing.
 */

/**
 * A step's failure with its code-behind context folded in — the one sentence
 * every single-line surface prints.
 *
 * @param {{error?: string, fromCodeBehind?: boolean,
 *          codeBehindStale?: {file: string, error: string}}} failure
 * @returns {string}
 */
export function describeStepFailure(failure) {
  const error = failure.error ?? "Step failed";
  // The stale case names BOTH: `error` is the AI failure that followed, and
  // dropping the crash would hide the reason the step ran under AI at all.
  if (failure.codeBehindStale) {
    return `${error} (its code-behind threw first: ${failure.codeBehindStale.error})`;
  }
  if (failure.fromCodeBehind) return `${error} (in its code-behind)`;
  return error;
}

/**
 * The inline block under a failed (✗) or stale (⚠) step row.
 *
 * A ⚠ row's step PASSED — only the entry's crash is worth showing, and there
 * is no step error to show. A ✗ row shows what the step died of, and both
 * errors, on their own lines, when a broken entry's AI fallback failed too.
 *
 * Returns null when there is nothing to say, so the caller renders no block.
 *
 * @param {{error?: string, fromCodeBehind?: boolean,
 *          codeBehindStale?: {file: string, error: string}}} failure
 * @param {boolean} isStale True for a ⚠ row, false for a ✗ row.
 * @returns {string | null}
 */
export function formatStepFailure(failure, isStale) {
  if (isStale) {
    return failure.codeBehindStale
      ? `code-behind failed: ${failure.codeBehindStale.error}`
      : null;
  }
  if (failure.codeBehindStale) {
    return (
      `code-behind threw: ${failure.codeBehindStale.error}\n` +
      `then failed under AI: ${failure.error ?? ""}`
    );
  }
  if (failure.fromCodeBehind) return `code-behind failed: ${failure.error ?? ""}`;
  return failure.error ?? null;
}

/**
 * `isSkippedPass` MIRRORS runner-core's function of the same name, for the
 * same reason `describeStepFailure` above is mirrored, and is pinned to it by
 * `tests/failure-text-copy-parity.test.js`.
 *
 * A step the run decided against rides the PASS event carrying
 * `output: 'skipped'` — the wire has no third verdict — so the panel's run log
 * must ask this before it prints a ✓ (stories/control-flow.md).
 *
 * @param {{output?: string}} event
 * @returns {boolean}
 */
export function isSkippedPass(event) {
  return event.output === "skipped";
}

/**
 * `SKIP_GLYPH` and `skipPanelLine` MIRROR `src/extension/step-skip-core.ts`,
 * for the same interop reason, and are pinned to it by
 * `tests/failure-text-copy-parity.test.js`.
 *
 * A skipped step reaches the panel two ways — `step:skip`, and `step:pass`
 * carrying `output: 'skipped'` — and both print this sentence, with the reason
 * when the server sent one. One glyph and one wording, or the panel says two
 * different things about the same event, which is what it did before these
 * were merged.
 *
 * The leading `Skipped:` is stripped — colon or no colon, since the runners'
 * no-sentence fallback is a bare `'Skipped'` — for the reason `because()` in
 * step-skip-core.ts gives: the server writes a standalone sentence for a
 * report cell, and pasted after "skipped" it stutters.
 *
 * @param {number} line
 * @param {string} [reason]
 * @returns {string}
 */
export const SKIP_GLYPH = "◌";

export function skipPanelLine(line, reason) {
  const trimmed = reason?.trim().replace(/^skipped\b\s*:?\s*/i, "");
  return `${SKIP_GLYPH} Step on line ${line} skipped${trimmed ? ` — ${trimmed}` : ""}`;
}
