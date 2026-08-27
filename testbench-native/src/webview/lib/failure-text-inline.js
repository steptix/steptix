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
