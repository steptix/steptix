import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  remapLineForChanges,
  remapLineSet,
  remapLineMap,
} from "../src/webview/lib/line-tracking.js";

// Build a Monaco-shaped IModelContentChange.
const change = (sLine, sCol, eLine, eCol, text) => ({
  range: { startLineNumber: sLine, startColumn: sCol, endLineNumber: eLine, endColumn: eCol },
  text,
});

// Pressing Enter at (line, col) splits the line.
const enterAt = (line, col) => change(line, col, line, col, "\n");

describe("remapLineForChanges — Enter key splits a line", () => {
  // SPEC: "if line 2 has a breakpoint and I press enter in line 1 to create a
  // line 2, then the line 2 breakpoint needs to move to line 3."
  it("Enter pressed mid-line 1 shifts the line-2 breakpoint to line 3", () => {
    const changes = [enterAt(1, 5)];
    assert.equal(remapLineForChanges(2, changes), 3);
  });

  it("Enter pressed at line 1 col 1 shifts a line-1 marker down to line 2", () => {
    const changes = [enterAt(1, 1)];
    // Original content of line 1 now lives on line 2 — the breakpoint follows.
    assert.equal(remapLineForChanges(1, changes), 2);
  });

  it("Enter pressed mid-line 1 leaves a line-1 marker on line 1 (first half stays)", () => {
    const changes = [enterAt(1, 5)];
    assert.equal(remapLineForChanges(1, changes), 1);
  });

  it("Enter pressed in line 1 shifts every line below by one", () => {
    const changes = [enterAt(1, 3)];
    assert.equal(remapLineForChanges(5, changes), 6);
    assert.equal(remapLineForChanges(10, changes), 11);
  });

  it("multiple Enters compound (paste of three newlines) shifts lines below by three", () => {
    const changes = [change(1, 3, 1, 3, "\n\n\n")];
    assert.equal(remapLineForChanges(2, changes), 5);
  });
});

describe("remapLineForChanges — typing within a line (no newlines)", () => {
  it("typing a character on line 1 leaves all line numbers unchanged", () => {
    const changes = [change(1, 4, 1, 4, "x")];
    assert.equal(remapLineForChanges(1, changes), 1);
    assert.equal(remapLineForChanges(2, changes), 2);
    assert.equal(remapLineForChanges(7, changes), 7);
  });
});

describe("remapLineForChanges — deletion", () => {
  it("deleting line 2 by selecting (2,1)→(3,1) drops line 2 and shifts line 3 to line 2", () => {
    // Selecting from start of line 2 to start of line 3 and replacing with ""
    // deletes line 2's content + its trailing newline.
    const changes = [change(2, 1, 3, 1, "")];
    assert.equal(remapLineForChanges(2, changes), null); // line 2's content is gone
    assert.equal(remapLineForChanges(3, changes), 2);
    assert.equal(remapLineForChanges(4, changes), 3);
    assert.equal(remapLineForChanges(5, changes), 4);
  });

  it("backspace at (3,1) merges line 3 content into line 2 — line 2 survives, line 3 maps to 2", () => {
    // Backspace at the start of line 3 deletes only the newline between L2 and L3.
    // Range: (2, lastColOfL2) → (3, 1).
    const changes = [change(2, 10, 3, 1, "")];
    assert.equal(remapLineForChanges(2, changes), 2);
    assert.equal(remapLineForChanges(3, changes), 2);
    assert.equal(remapLineForChanges(4, changes), 3);
  });

  it("deleting lines 3-5 by selecting (3,1)→(6,1) drops 3, 4, 5 and shifts line 6 to line 3", () => {
    const changes = [change(3, 1, 6, 1, "")];
    assert.equal(remapLineForChanges(3, changes), null);
    assert.equal(remapLineForChanges(4, changes), null);
    assert.equal(remapLineForChanges(5, changes), null);
    assert.equal(remapLineForChanges(6, changes), 3);
    assert.equal(remapLineForChanges(7, changes), 4);
  });
});

describe("remapLineForChanges — replacement with new content", () => {
  it("replacing line 2 with two lines shifts line 3 down by one", () => {
    // Replace (2,1)→(3,1) with "foo\nbar\n" — old: 1 line removed, new: 2 lines.
    const changes = [change(2, 1, 3, 1, "foo\nbar\n")];
    assert.equal(remapLineForChanges(1, changes), 1);
    assert.equal(remapLineForChanges(3, changes), 4);
  });
});

describe("remapLineSet / remapLineMap", () => {
  it("remapLineSet drops deleted lines and shifts the rest", () => {
    const breakpoints = new Set([2, 5, 7]);
    // Press Enter at line 3 col 5 → lines >= 4 shift by +1.
    const changes = [enterAt(3, 5)];
    const next = remapLineSet(breakpoints, changes, 100);
    assert.deepEqual([...next].sort((a, b) => a - b), [2, 6, 8]);
  });

  it("remapLineSet drops lines that fall outside [1, lineCount]", () => {
    const breakpoints = new Set([2, 5]);
    const changes = [change(4, 1, 6, 1, "")]; // delete a chunk near the end
    const next = remapLineSet(breakpoints, changes, 4);
    assert.ok(next.has(2));
    assert.ok(!next.has(5));
  });

  it("remapLineMap shifts status keys with the lines", () => {
    const statuses = { 2: "pass", 5: "fail" };
    const changes = [enterAt(1, 1)]; // shift everything below line 1 down by 1
    const next = remapLineMap(statuses, changes, 100);
    assert.equal(next[3], "pass");
    assert.equal(next[6], "fail");
  });

  it("remapLineMap drops keys for deleted lines", () => {
    const statuses = { 2: "pass", 3: "fail", 4: "skip" };
    const changes = [change(3, 1, 4, 1, "")]; // delete line 3
    const next = remapLineMap(statuses, changes, 100);
    assert.equal(next[2], "pass");
    assert.ok(!("3" in next) || next[3] === "skip");
    assert.equal(next[3], "skip");
  });
});

describe("remapLineForChanges — SPEC scenario from the bug report", () => {
  // "If line 2 has a breakpoint and I press enter in line 1 to create a line
  //  2, then the line 2 breakpoint needs to move to line 3. The same with all
  //  the pass/fail decorators."
  it("breakpoints, statuses, and breakpointStop all follow the line content", () => {
    const breakpoints = new Set([2]);
    const statuses = { 2: "pass", 4: "fail" };
    const breakpointStop = 2;
    const changes = [enterAt(1, 5)];

    const nextBreakpoints = remapLineSet(breakpoints, changes, 100);
    const nextStatuses = remapLineMap(statuses, changes, 100);
    const nextBreakpointStop = remapLineForChanges(breakpointStop, changes);

    assert.deepEqual([...nextBreakpoints], [3]);
    assert.deepEqual(nextStatuses, { 3: "pass", 5: "fail" });
    assert.equal(nextBreakpointStop, 3);
  });
});
