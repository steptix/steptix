/**
 * The compile-tail strip's wording, for the webview panel.
 *
 * The headline and the detail line live only here: nothing on the extension
 * side draws them, and their wording is pinned by
 * `tests/compile-progress.test.js`.
 *
 * `stripFractionInline` MIRRORS `stripFraction` in
 * `src/extension/compile-progress-core.ts`, which the toast's increment is
 * computed from. The webview can't import from the extension side (Vite's CJS
 * interop drops runner-core's named exports through __exportStar — the same
 * reason `step-lines-inline.js` and `failure-text-inline.js` exist), so the
 * rule is duplicated here and pinned to the original by
 * `tests/compile-strip-copy-parity.test.js`. Change one, change both: a
 * divergence means the panel's bar and the toast's bar disagree about how far
 * the same compile has got.
 */

/**
 * @typedef {{file: string, done: number|null, total: number|null,
 *            phase: 'generate'|'review', step?: number, line?: number,
 *            reviewPending?: boolean}} CompileTail
 */

/**
 * "Compiling code-behind — 5 of 8 entries generated · review next", or the
 * indeterminate form when the server sent no counts.
 * @param {CompileTail} tail
 * @returns {string}
 */
export function stripHeadlineInline(tail) {
  if (tail.phase === "review") return "Compiling code-behind — reviewing the generated file";
  if (tail.done === null || tail.total === null) return "Compiling code-behind…";
  const suffix = tail.reviewPending ? " · review next" : "";
  return `Compiling code-behind — ${tail.done} of ${tail.total} entries generated${suffix}`;
}

/**
 * The dimmed second line naming what is being worked on, or null.
 * @param {CompileTail} tail
 * @returns {string|null}
 */
export function stripDetailInline(tail) {
  if (tail.phase === "review") return "Reviewing the whole file before it is proposed";
  if (tail.step === undefined) return null;
  return tail.line === undefined
    ? `Generating step ${tail.step}`
    : `Generating step ${tail.step} — line ${tail.line}`;
}

/**
 * 0..1 for the determinate bar, or null when the counts are unknown.
 * @param {CompileTail} tail
 * @returns {number|null}
 */
export function stripFractionInline(tail) {
  if (tail.done === null || tail.total === null || tail.total <= 0) return null;
  return Math.max(0, Math.min(1, tail.done / tail.total));
}
