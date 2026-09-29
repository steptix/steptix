/**
 * The panel's per-file state (stories/compile-tail-progress.md §The panel log).
 *
 * One webview, many controllers. What is pinned here is that nothing ever
 * leaks between files: the log the panel renders is the active file's, Clear
 * clears that one only, and two compiles running at once keep their lines
 * apart. The pre-existing bug this closes was test B's panel showing test A's
 * run; the bug it prevents is two generation queues interleaving in one pane.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  appendLogLine,
  clearLogFor,
  logFor,
  setStrip,
  stripFor,
} from "../src/webview/lib/panel-scope-inline.js";

const A = "file:///w/securebank.md";
const B = "file:///w/github.md";
const line = (msg) => ({ msg, kind: "info", ts: "00:00:00" });

test("a file's lines are visible only in that file's view", () => {
  let logs = {};
  logs = appendLogLine(logs, A, line("generating step 1"));
  logs = appendLogLine(logs, B, line("Running step on line 4"));
  assert.deepEqual(logFor(logs, A).map((e) => e.msg), ["generating step 1"]);
  assert.deepEqual(logFor(logs, B).map((e) => e.msg), ["Running step on line 4"]);
});

test("two concurrent compiles never interleave in one view", () => {
  // The frames arrive interleaved, because both streams are live at once.
  let logs = {};
  for (const [uri, msg] of [
    [A, "a1"],
    [B, "b1"],
    [A, "a2"],
    [B, "b2"],
    [A, "a3"],
  ]) {
    logs = appendLogLine(logs, uri, line(msg));
  }
  assert.deepEqual(logFor(logs, A).map((e) => e.msg), ["a1", "a2", "a3"]);
  assert.deepEqual(logFor(logs, B).map((e) => e.msg), ["b1", "b2"]);
});

test("a file with no log yet renders empty rather than someone else's", () => {
  const logs = appendLogLine({}, A, line("a1"));
  assert.deepEqual(logFor(logs, B), []);
  assert.deepEqual(logFor(logs, null), []);
});

test("Clear clears the active file's log only", () => {
  let logs = appendLogLine(appendLogLine({}, A, line("a1")), B, line("b1"));
  logs = clearLogFor(logs, A);
  assert.deepEqual(logFor(logs, A), []);
  // B's compile may still be running; its lines are still its own.
  assert.deepEqual(logFor(logs, B).map((e) => e.msg), ["b1"]);
});

test("clearing a file with nothing to clear changes nothing", () => {
  const logs = appendLogLine({}, A, line("a1"));
  assert.equal(clearLogFor(logs, B), logs, "identity preserved — no needless re-render");
  assert.equal(clearLogFor(logs, null), logs);
});

test("a message that belongs to no file is dropped, not pooled", () => {
  // Pooling under a shared key is how the lines would later surface in
  // whichever file happened to be active when someone read the pool.
  const logs = appendLogLine({}, null, line("orphan"));
  assert.deepEqual(logs, {});
});

// ── the strip ─────────────────────────────────────────────────────────────

test("the strip renders for its own file and no other", () => {
  const tail = { file: "securebank.md", done: 5, total: 8, phase: "generate" };
  const strips = setStrip({}, A, tail);
  assert.deepEqual(stripFor(strips, A), tail);
  // Switching to github.md removes it — different file, different context.
  assert.equal(stripFor(strips, B), null);
  assert.equal(stripFor(strips, null), null);
});

test("switching away and back finds the strip at its current count", () => {
  let strips = setStrip({}, A, { file: "securebank.md", done: 2, total: 8, phase: "generate" });
  strips = setStrip(strips, A, { file: "securebank.md", done: 6, total: 8, phase: "generate" });
  assert.equal(stripFor(strips, A).done, 6);
});

test("the result takes down that file's strip and leaves the other's up", () => {
  let strips = setStrip({}, A, { file: "securebank.md", done: 8, total: 8, phase: "review" });
  strips = setStrip(strips, B, { file: "github.md", done: 1, total: 3, phase: "generate" });
  strips = setStrip(strips, A, null);
  assert.equal(stripFor(strips, A), null);
  assert.equal(stripFor(strips, B).done, 1);
});

test("taking down a strip that is not up changes nothing", () => {
  const strips = setStrip({}, A, { file: "a.md", done: 0, total: 1, phase: "generate" });
  assert.equal(setStrip(strips, B, null), strips);
});
