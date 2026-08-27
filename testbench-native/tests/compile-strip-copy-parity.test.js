/**
 * Copy-parity for the compile strip's wording.
 *
 * The strip is drawn by the webview and the same numbers are drawn by the
 * status bar item and the toast on the extension side, so the phrasing exists
 * twice: `src/extension/compile-progress-core.ts` and the webview's mirror in
 * `src/webview/lib/compile-strip-inline.js`. The webview cannot import the
 * extension side (Vite's CJS interop drops named exports through
 * __exportStar — the same reason `failure-text-inline.js` exists).
 *
 * A mirror that drifts is the failure this file exists to catch: the panel
 * saying "5 of 8 entries generated" while the status bar says something else
 * about the same compile is exactly the confusion the story set out to remove,
 * and it would merge cleanly.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  stripDetailInline,
  stripFractionInline,
  stripHeadlineInline,
} from "../src/webview/lib/compile-strip-inline.js";
import {
  stripDetail,
  stripFraction,
  stripHeadline,
} from "../src/extension/compile-progress-core.ts";

/** Every shape the wording branches on, degenerate ones included. */
const CASES = [
  { file: "a.md", done: 5, total: 8, phase: "generate", step: 6, line: 22, reviewPending: true },
  { file: "a.md", done: 5, total: 8, phase: "generate", step: 6, reviewPending: true },
  { file: "a.md", done: 5, total: 8, phase: "generate", step: 6 },
  { file: "a.md", done: 0, total: 1, phase: "generate" },
  { file: "a.md", done: 8, total: 8, phase: "review" },
  { file: "a.md", done: null, total: null, phase: "generate" },
  { file: "a.md", done: null, total: null, phase: "generate", step: 3, line: 9 },
  { file: "a.md", done: 0, total: 0, phase: "generate" },
];

for (const [i, tail] of CASES.entries()) {
  test(`webview mirror matches the extension side for case ${i}`, () => {
    assert.equal(stripHeadlineInline(tail), stripHeadline(tail), "headline");
    assert.equal(stripDetailInline(tail), stripDetail(tail), "detail");
    assert.equal(stripFractionInline(tail), stripFraction(tail), "fraction");
  });
}
