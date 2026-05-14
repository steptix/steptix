import { test } from "node:test";
import { strict as assert } from "node:assert";
import { nextBreakpointStop } from "../src/webview/lib/breakpoint.js";

test("nextBreakpointStop: returns null when nothing was trimmed", () => {
  assert.equal(nextBreakpointStop(null, "passed"), null);
});

test("nextBreakpointStop: returns the trim line when status is passed", () => {
  assert.equal(nextBreakpointStop(7, "passed"), 7);
});

test("nextBreakpointStop: returns null on failed", () => {
  // The user has to deal with the failure first — we never reached the breakpoint.
  assert.equal(nextBreakpointStop(7, "failed"), null);
});

test("nextBreakpointStop: returns null on aborted", () => {
  assert.equal(nextBreakpointStop(7, "aborted"), null);
});

test("nextBreakpointStop: returns null on error", () => {
  assert.equal(nextBreakpointStop(7, "error"), null);
});

test("nextBreakpointStop: returns null on unknown status (defensive)", () => {
  assert.equal(nextBreakpointStop(7, "weird"), null);
});
