/**
 * Step lines for the webview.
 *
 * Which lines are steps is runner-core's answer, imported here rather than
 * copied. This file used to hold a hand copy of the grammar, written when "the
 * webview can't import runner-core directly because Vite's CJS interop drops
 * named exports through __exportStar" — and the copy drifted: it called an
 * indented `  1. Click Save` a step while a run skipped it (steptix/steptix#49).
 *
 * That interop problem is specific to runner-core's `index.js`, which
 * re-exports every module through `__exportStar`. `dist/step-lines.js` is a
 * plain CommonJS module (`exports.extractStepLineIds = …`) with no Node
 * imports, so the webview imports it directly. tests/webview-runner-core.test.js
 * builds this file with Vite and calls the bundled functions, so a regression
 * of the interop problem fails a unit test instead of blanking the gutter.
 *
 * `extractStepLineIds` returns main-flow AND inline-section body lines: the
 * webview paints, anchors and filters by these ids, and a body line is still a
 * line the user can see and click (stories/test-script-sections-contract.md
 * §5, consumer split).
 */

export { extractStepLineIds } from "steptix-runner-core/dist/step-lines.js";

/**
 *
 * `statuses` is the whole snapshot's line → status map, and a snapshot holds
 * more than steps: since PR #137 every data-table ROW line wears a status too,
 * and a row the run never reached is painted `skip` — which the Rows panel two
 * inches below calls "not run". Counted with the steps, a Stop part-way through
 * a three-row table renders `◌ 3 skipped` in the header with nothing returned
 * and no step skipped, contradicting the panel's own Rows section.
 *
 * `stepLineIds` is `extractStepLineIds` of the same text: main-flow and inline
 * section body lines, which is exactly what the header means by a step. Row
 * lines are table pipes and match no numbered-item regex, so they are outside
 * it by construction rather than by an exclusion list that could drift.
 *
 * The pass breakdown is folded in here too, so all five numbers come from one
 * filter and cannot disagree about which lines they were counting.
 */
export function countStepLineStatuses(statuses, stepLineIds, notTakenLines) {
  const ids = new Set(stepLineIds ?? []);
  const entries = Object.entries(statuses ?? {}).filter(([line]) => ids.has(Number(line)));
  const mine = entries.map(([, status]) => status);
  const count = (...wanted) => mine.filter((s) => wanted.includes(s)).length;
  // A ⚠ on a line that did NOT run — a chain member whose condition's code
  // threw on the visit that took another member (the detail's `notTaken`). It
  // is there to offer Repair; the step was still skipped, never passed.
  const notTaken = new Set(notTakenLines ?? []);
  const staleNotTaken = entries.filter(
    ([line, status]) => status === "pass-stale" && notTaken.has(Number(line)),
  ).length;
  return {
    // Every 'pass*' is a passed step; what differs is what it cost, which is
    // what the breakdown beside it says.
    pass: count("pass", "pass-code-behind", "pass-stale") - staleNotTaken,
    codeBehind: count("pass-code-behind"),
    stale: count("pass-stale"),
    fail: count("fail"),
    skip: count("skip") + staleNotTaken,
    // A step that failed and the run carried on past it — an `otherwise continue`
    // tail (stories/step-failure-outcomes.md, decision 6). Counted apart from BOTH
    // `pass` and `fail`: it did not do its work, and the run is not red for it.
    tolerated: count("fail-tolerated"),
  };
}
