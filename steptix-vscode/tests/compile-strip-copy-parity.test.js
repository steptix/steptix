/**
 * Copy-parity for the compile strip's bar.
 *
 * The panel strip's bar and the toast's progress bar show the same compile's
 * position, so the rule that turns counts into a fraction exists twice:
 * `stripFraction` in `src/extension/compile-progress-core.ts` (which the
 * toast's increment is computed from) and the webview's mirror,
 * `stripFractionInline` in `src/webview/lib/compile-strip-inline.js`. The
 * webview cannot import the extension side (Vite's CJS interop drops named
 * exports through __exportStar — the same reason `failure-text-inline.js`
 * exists).
 *
 * A mirror that drifts is the failure this file exists to catch: the panel's
 * bar full while the toast's sits at half, or a bar in one place and none in
 * the other, is exactly the confusion the story set out to remove, and it
 * would merge cleanly.
 *
 * The strip's headline and detail line have no extension-side copy — only the
 * webview draws them — so there is nothing to compare; their wording is
 * pinned in compile-progress.test.js.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { stripFractionInline } from "../src/webview/lib/compile-strip-inline.js";
import { stripFraction } from "../src/extension/compile-progress-core.ts";

/** Every shape the fraction branches on, degenerate ones included. */
const CASES = [
  { file: "a.md", done: 5, total: 8, phase: "generate", step: 6, line: 22, reviewPending: true },
  { file: "a.md", done: 0, total: 1, phase: "generate" },
  { file: "a.md", done: 8, total: 8, phase: "review" },
  { file: "a.md", done: null, total: null, phase: "generate" },
  { file: "a.md", done: 5, total: null, phase: "generate" },
  { file: "a.md", done: 0, total: 0, phase: "generate" },
  { file: "a.md", done: 99, total: 8, phase: "generate" },
];

for (const [i, tail] of CASES.entries()) {
  test(`webview bar matches the toast's for case ${i}`, () => {
    assert.equal(stripFractionInline(tail), stripFraction(tail));
  });
}
