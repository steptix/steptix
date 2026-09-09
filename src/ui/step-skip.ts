/**
 * What a skipped step looks like in the Runner UI.
 *
 * A MIRROR of `testbench-native/src/extension/step-skip-core.ts`, which is the
 * original and carries the reasoning. Copied rather than imported because the
 * two live in different packages: `testbench-native` is a `file:`-installed VS
 * Code extension that depends on `runner-core`, and nothing in it may be
 * imported from `src/`. The module it mirrors is already VS-Code-free for the
 * same kind of reason.
 *
 * It exists because the Runner UI was the one surface the merged presentation
 * did not reach: it printed `— Step 5 skipped: Skipped: another branch of this
 * decision was taken` — a different glyph, a different separator, a
 * capitalised "Step", and the word "skipped" twice — while the six TestBench
 * surfaces beside it printed `◌ step 5 skipped — another branch of this
 * decision was taken`. The story claims "one glyph, one paint precedence, one
 * sentence"; this is what makes that true of the fourth client too.
 *
 * Kept honest by `tests/ui-skip-line-parity.test.ts`, which reads both files
 * and compares them.
 */

/** The mark a line that never ran wears — a hollow circle. One shape for
 *  "planned, not run", wherever it is said. */
export const SKIP_GLYPH = '◌';

/**
 * The reason clause, or nothing.
 *
 * Blank and whitespace-only are treated as absent so a runner that reports an
 * empty reason cannot produce a trailing dash. The leading `Skipped:` goes,
 * with or without its colon: `skipReasonFor` (src/runner/control-runtime.ts)
 * writes a standalone sentence because that is what a report CELL holds, and
 * the runners fall back to a bare `'Skipped'` when they have no sentence at
 * all — pasted into this line either one stutters. Anchored on a word
 * boundary, so a mid-sentence mention is left alone.
 */
function because(reason?: string): string {
  const trimmed = reason?.trim().replace(/^skipped\b\s*:?\s*/i, '');
  return trimmed ? ` — ${trimmed}` : '';
}

/**
 * The Runner UI log's line — the surface `✓ Step 5 passed (1.2s)` and
 * `✗ Step 5 failed: …` share.
 *
 * Addressed by STEP INDEX rather than by source line, and capitalised, because
 * that is what the two lines beside it do here. The glyph, the word and the
 * reason clause are the shared half.
 */
export function skipLogLine(stepIndex: number, reason?: string): string {
  return `${SKIP_GLYPH} Step ${stepIndex} skipped${because(reason)}`;
}
