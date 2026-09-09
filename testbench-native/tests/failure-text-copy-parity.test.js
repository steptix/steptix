/**
 * Copy-parity for the failure phrasing.
 *
 * `describeStepFailure` exists twice — once in runner-core (host surfaces: the
 * run log, the compile fold, Test Explorer) and once mirrored in
 * `src/webview/lib/failure-text-inline.js`, because Vite's CJS interop drops
 * runner-core's named exports through __exportStar (same reason
 * `step-lines-inline.js` exists).
 *
 * The whole point of consolidating the wording was that the surfaces had
 * drifted — "(code-behind) X" in one place, "Code-behind failed: X" in
 * another, for the same event. A mirror that drifts re-creates exactly that,
 * and merges cleanly while doing it. So the two copies are pinned here, over
 * the full cross-product of the fields that steer the phrasing.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  describeStepFailure as inlineDescribe,
  formatStepFailure,
  isSkippedPass as inlineSkipped,
  skipPanelLine as inlinePanelLine,
  SKIP_GLYPH as inlineGlyph,
} from "../src/webview/lib/failure-text-inline.js";
import {
  describeStepFailure as coreDescribe,
  isSkippedPass as coreSkipped,
} from "../src/../../runner-core/src/protocol.ts";
import {
  skipPanelLine as corePanelLine,
  SKIP_GLYPH as coreGlyph,
} from "../src/extension/step-skip-core.ts";

const CB = { file: "/p/tests/booking.steps.ts", error: "locator resolved to 2 elements" };

/** Every shape the phrasing branches on, including the degenerate ones. */
const CASES = [
  { error: "no such button" },
  { error: "the confirmation banner never appeared", fromCodeBehind: true },
  { error: "AI could not find the button either", codeBehindStale: CB },
  // stale wins over fromCodeBehind — both set is reachable on a strict replay
  { error: "boom", fromCodeBehind: true, codeBehindStale: CB },
  // no error at all: the fallback must be identical on both sides
  {},
  { fromCodeBehind: true },
  { codeBehindStale: CB },
  { error: "" },
];

for (const [i, failure] of CASES.entries()) {
  test(`webview mirror matches runner-core for case ${i}`, () => {
    assert.equal(
      inlineDescribe(failure),
      coreDescribe(failure),
      `divergent phrasing for ${JSON.stringify(failure)}`,
    );
  });
}

test("the shared phrasing names both errors for a failed heal", () => {
  const text = coreDescribe({ error: "AI could not find it", codeBehindStale: CB });
  assert.match(text, /AI could not find it/);
  assert.match(text, /locator resolved to 2 elements/);
});

test("a missing error falls back rather than printing undefined", () => {
  assert.equal(coreDescribe({}), "Step failed");
  assert.doesNotMatch(inlineDescribe({}), /undefined/);
});

// ── formatStepFailure: the panel's own block, NOT a mirror ─────────────────

test("a ⚠ row shows only the entry's crash — its step passed", () => {
  const text = formatStepFailure({ codeBehindStale: CB }, true);
  assert.match(text, /code-behind failed: locator resolved to 2 elements/);
});

test("a ⚠ row with no crash recorded renders no block", () => {
  assert.equal(formatStepFailure({}, true), null);
});

test("a ✗ row after a failed heal shows both errors on their own lines", () => {
  const text = formatStepFailure({ error: "AI failed too", codeBehindStale: CB }, false);
  const [first, second] = text.split("\n");
  assert.match(first, /code-behind threw: locator resolved to 2 elements/);
  assert.match(second, /then failed under AI: AI failed too/);
});

test("a plain ✗ row shows the error alone", () => {
  assert.equal(formatStepFailure({ error: "no such button" }, false), "no such button");
});

// ── isSkippedPass: the second mirrored predicate ───────────────────────────
//
// A step the run decided against rides the PASS event with `output: 'skipped'`
// (stories/control-flow.md). The extension host asks runner-core; the panel
// cannot import it, so it asks its own copy. A copy that drifts paints the
// untaken branch of a chain green in one surface and grey in the other, which
// is exactly the divergence this file exists to prevent.

for (const [i, event] of [
  { type: "step:pass", line: 1, output: "skipped" },
  { type: "step:pass", line: 1 },
  { type: "step:pass", line: 1, output: "" },
  { type: "step:pass", line: 1, output: "Skipped" },
  { type: "step:pass", line: 1, output: "the Cash checkbox is ticked" },
  {},
].entries()) {
  test(`webview isSkippedPass matches runner-core for case ${i}`, () => {
    assert.equal(
      inlineSkipped(event),
      coreSkipped(event),
      `divergent verdict for ${JSON.stringify(event)}`,
    );
  });
}

test("only the exact sentinel counts as a step that did not run", () => {
  assert.equal(coreSkipped({ output: "skipped" }), true);
  assert.equal(coreSkipped({ output: "skipped: no branch held" }), false);
  assert.equal(coreSkipped({}), false);
});

// ── skipPanelLine + SKIP_GLYPH: the third mirrored pair ────────────────────
//
// `step-skip-core.ts` and `failure-text-inline.js` BOTH said this file pinned
// them. It did not — it covered `describeStepFailure`, `formatStepFailure` and
// `isSkippedPass` and nothing else — so the two copies of the sentence agreed
// only by luck, and a reword of one would have merged cleanly and shipped two
// vocabularies for one event. That is the exact drift the consolidation was
// for, so the claim is made true here rather than deleted from the docstrings.

test("the skip glyph is one codepoint on both sides", () => {
  assert.equal(inlineGlyph, coreGlyph);
  assert.equal(coreGlyph.codePointAt(0), 0x25cc, "U+25CC DOTTED CIRCLE");
});

for (const [i, args] of [
  [12],
  [12, 'Not run: step 3 returned from "Sign in"'],
  // The report-cell sentence, whose leading "Skipped:" both copies strip —
  // `◌ Step on line 5 skipped — Skipped: …` stutters.
  [5, "Skipped: another branch of this decision was taken"],
  [5, "skipped:   the list was empty"],
  // Degenerate reasons: absent, empty, whitespace, and a reason that is
  // nothing BUT the prefix. None may leave a dangling dash.
  [5, ""],
  [5, "   "],
  [5, "Skipped:"],
  [5, undefined],
].entries()) {
  test(`webview skipPanelLine matches step-skip-core for case ${i}`, () => {
    assert.equal(
      inlinePanelLine(...args),
      corePanelLine(...args),
      `divergent skip sentence for ${JSON.stringify(args)}`,
    );
    assert.doesNotMatch(corePanelLine(...args), /—\s*$/, "no dangling em dash");
  });
}
