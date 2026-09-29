/**
 * The compile tail's wording and its arithmetic
 * (stories/compile-tail-progress.md).
 *
 * Three surfaces read the same numbers — the panel strip, the toast's detail
 * line and the status bar item — and the rules about WHEN each of them says
 * nothing are the ones worth pinning: an idle spinner, a bar with a position
 * it does not have, or a status bar item that survives the compile it
 * describes are each worse than the silence this story replaced.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  notificationDetail,
  progressIncrement,
  quickPickLabel,
  statusBarText,
  statusBarTooltip,
  stripDetail,
  stripFraction,
  stripHeadline,
} from "../src/extension/compile-progress-core.ts";

/** A tail mid-generation, with counts. */
const generating = {
  file: "securebank.md",
  done: 5,
  total: 8,
  phase: "generate",
  step: 6,
  line: 22,
  reviewPending: true,
};

/** The same tail against a server that sends no `compile:progress`. */
const indeterminate = { file: "securebank.md", done: null, total: null, phase: "generate" };

const reviewing = { file: "securebank.md", done: 8, total: 8, phase: "review" };

// ── the strip ─────────────────────────────────────────────────────────────

test("the headline names the count and what follows it", () => {
  assert.equal(
    stripHeadline(generating),
    "Compiling code-behind — 5 of 8 entries generated · review next",
  );
});

test("a 'steps' compile promises no review — that path runs none", () => {
  const { reviewPending, ...steps } = generating;
  assert.equal(stripHeadline(steps), "Compiling code-behind — 5 of 8 entries generated");
});

test("with no counts the strip says only that it is working", () => {
  // The version-skew case: a new client on an older server. Inventing a
  // position for the bar would be a lie, and saying nothing is the state this
  // story exists to remove.
  assert.equal(stripHeadline(indeterminate), "Compiling code-behind…");
  assert.equal(stripFraction(indeterminate), null);
  assert.equal(stripDetail(indeterminate), null);
});

test("Review speaks for the file, not for a step", () => {
  assert.match(stripHeadline(reviewing), /reviewing the generated file/);
  assert.match(stripDetail(reviewing), /whole file/);
});

test("the detail line names the step being generated right now", () => {
  assert.equal(stripDetail(generating), "Generating step 6 — line 22");
  const { line, ...noLine } = generating;
  assert.equal(stripDetail(noLine), "Generating step 6");
});

test("the bar's fraction stays inside 0..1 whatever the counts say", () => {
  assert.equal(stripFraction(generating), 5 / 8);
  assert.equal(stripFraction({ ...generating, done: 0 }), 0);
  assert.equal(stripFraction({ ...generating, done: 8 }), 1);
  // A total of zero is not a bar; it is an absence of one.
  assert.equal(stripFraction({ ...generating, done: 0, total: 0 }), null);
  // Defensive: a done past total clamps rather than overflowing the div.
  assert.equal(stripFraction({ ...generating, done: 99 }), 1);
});

// ── the status bar item ───────────────────────────────────────────────────

test("one compile names its file; several name only the count", () => {
  assert.equal(statusBarText([generating]), "$(sync~spin) Steptix: compiling securebank.md 5/8");
  assert.equal(
    statusBarText([generating, { ...generating, file: "github.md" }]),
    "$(sync~spin) Steptix: compiling 2",
  );
});

test("no compile, no item — an idle spinner is a lie", () => {
  assert.equal(statusBarText([]), "");
  assert.equal(statusBarTooltip([]), "");
});

test("a compile with no counts still names its file", () => {
  assert.equal(statusBarText([indeterminate]), "$(sync~spin) Steptix: compiling securebank.md");
});

test("the quick-pick row says which file, how far, and doing what", () => {
  assert.equal(quickPickLabel(generating), "securebank.md — 5 of 8 · generating");
  assert.equal(quickPickLabel(reviewing), "securebank.md — 8 of 8 · reviewing");
  assert.equal(quickPickLabel(indeterminate), "securebank.md · generating");
});

// ── the notification ──────────────────────────────────────────────────────

test("the toast's detail carries the numbers; the file is in its title", () => {
  assert.equal(notificationDetail(generating), "5 of 8 entries generated · step 6");
  assert.equal(notificationDetail(reviewing), "reviewing the generated file");
  // Nothing to say yet, rather than a detail line reading "null of null".
  assert.equal(notificationDetail(indeterminate), "");
});

test("the toast's increment is a delta, and never a negative one", () => {
  // `Progress.report({increment})` ADDS: reporting 60 twice fills to 120%.
  assert.equal(progressIncrement({ ...generating, done: 2 }, 0), 25);
  assert.equal(progressIncrement({ ...generating, done: 4 }, 2 / 8), 25);
  // A repeated or out-of-order count adds nothing — VS Code cannot render a
  // bar going backwards, and winding it back would look like a restart.
  assert.equal(progressIncrement({ ...generating, done: 4 }, 4 / 8), 0);
  assert.equal(progressIncrement({ ...generating, done: 1 }, 4 / 8), 0);
  assert.equal(progressIncrement(indeterminate, 0), 0);
});
