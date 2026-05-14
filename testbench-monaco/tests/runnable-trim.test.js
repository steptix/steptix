import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeRunnable } from "../src/webview/lib/runnable-trim.js";

const steps = (...ids) => ids.map((id) => ({ id, text: `step ${id}` }));

test("computeRunnable: empty selection → empty runnable, no pause", () => {
  assert.deepEqual(computeRunnable([], new Set()), { runnable: [], pausedAt: null });
});

test("computeRunnable: no breakpoints → all steps run", () => {
  const got = computeRunnable(steps(1, 2, 3), new Set());
  assert.deepEqual(got.runnable.map((s) => s.id), [1, 2, 3]);
  assert.equal(got.pausedAt, null);
});

test("computeRunnable: breakpoint on a later line trims at that line", () => {
  const got = computeRunnable(steps(1, 2, 3, 4), new Set([3]));
  assert.deepEqual(got.runnable.map((s) => s.id), [1, 2]);
  assert.equal(got.pausedAt, 3);
});

test("computeRunnable: breakpoint on the FIRST selected line stops immediately by default", () => {
  // Run-from-top with a breakpoint on line 1 should not execute line 1.
  const got = computeRunnable(steps(1, 2, 3), new Set([1]));
  assert.deepEqual(got.runnable.map((s) => s.id), []);
  assert.equal(got.pausedAt, 1);
});

test("computeRunnable: skipBreakpointAtStart lets the first line run (Resume case)", () => {
  const got = computeRunnable(steps(1, 2, 3), new Set([1]), { skipBreakpointAtStart: true });
  assert.deepEqual(got.runnable.map((s) => s.id), [1, 2, 3]);
  assert.equal(got.pausedAt, null);
});

test("computeRunnable: skipBreakpointAtStart still trims at the NEXT breakpoint", () => {
  // Breakpoints on 1 and 3; Resume from 1 should run lines 1 + 2 and pause at 3.
  const got = computeRunnable(steps(1, 2, 3, 4), new Set([1, 3]), { skipBreakpointAtStart: true });
  assert.deepEqual(got.runnable.map((s) => s.id), [1, 2]);
  assert.equal(got.pausedAt, 3);
});

test("computeRunnable: only the first step gets the skip exemption", () => {
  // Even with skipBreakpointAtStart, a breakpoint on a later line still pauses.
  const got = computeRunnable(steps(1, 2), new Set([2]), { skipBreakpointAtStart: true });
  assert.deepEqual(got.runnable.map((s) => s.id), [1]);
  assert.equal(got.pausedAt, 2);
});

test("computeRunnable: sorts the input by id before trimming", () => {
  // Caller might hand us out-of-order steps; trim must be document-order.
  const got = computeRunnable(steps(3, 1, 2), new Set([2]));
  assert.deepEqual(got.runnable.map((s) => s.id), [1]);
  assert.equal(got.pausedAt, 2);
});
