import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getLinesFromSelections,
  toggleLineInSet,
} from "../selection-lines.js";

const sel = (sLine, sCol, eLine, eCol) => ({
  startLineNumber: sLine,
  startColumn: sCol,
  endLineNumber: eLine,
  endColumn: eCol,
});

describe("getLinesFromSelections", () => {
  it("returns the fallback line when there are no selections", () => {
    assert.deepEqual([...getLinesFromSelections([], 7)], [7]);
    assert.deepEqual([...getLinesFromSelections(undefined, 3)], [3]);
  });

  it("returns a single line for a same-line selection", () => {
    assert.deepEqual([...getLinesFromSelections([sel(2, 1, 2, 40)], 1)], [2]);
  });

  // Regression: the Alt+Click bug — Monaco's default line-number click sets
  // a selection of (N,1)→(N+1,1). The trailing column-1 boundary must NOT
  // include line N+1 in the highlight set.
  it("does not include the trailing line when the selection ends at column 1", () => {
    assert.deepEqual([...getLinesFromSelections([sel(1, 1, 2, 1)], 1)], [1]);
  });

  it("includes the trailing line when the selection ends past column 1", () => {
    assert.deepEqual([...getLinesFromSelections([sel(1, 1, 2, 5)], 1)], [1, 2]);
  });

  it("handles reversed selections (start line > end line)", () => {
    assert.deepEqual([...getLinesFromSelections([sel(3, 1, 1, 5)], 1)], [1, 2]);
  });

  it("handles reversed selections that end on a column-1 boundary", () => {
    // Anchor at line 3 column 1, cursor at line 1 column max — the boundary
    // is at line 3 column 1, so line 3 should NOT be in the set.
    assert.deepEqual([...getLinesFromSelections([sel(3, 1, 1, 5)], 1)], [1, 2]);
  });

  it("merges multiple non-contiguous selections into a flat line set", () => {
    const selections = [
      sel(2, 1, 2, 10),
      sel(5, 1, 5, 10),
      sel(7, 1, 7, 10),
    ];
    assert.deepEqual([...getLinesFromSelections(selections, 1)], [2, 5, 7]);
  });

  it("covers a continuous multi-line range", () => {
    assert.deepEqual([...getLinesFromSelections([sel(2, 1, 4, 8)], 1)], [2, 3, 4]);
  });
});

describe("toggleLineInSet (Alt+Click toggle)", () => {
  it("adds a line that isn't in the set", () => {
    const next = toggleLineInSet(new Set([1]), 3);
    assert.deepEqual([...next].sort((a, b) => a - b), [1, 3]);
  });

  it("removes a line that is already in the set when other lines remain selected", () => {
    const next = toggleLineInSet(new Set([1, 3, 5]), 3);
    assert.deepEqual([...next].sort((a, b) => a - b), [1, 5]);
  });

  it("keeps the line when it is the only selected line — never leaves the set empty", () => {
    const next = toggleLineInSet(new Set([4]), 4);
    assert.deepEqual([...next], [4]);
  });

  it("treats an empty set as a fresh add", () => {
    const next = toggleLineInSet(new Set(), 7);
    assert.deepEqual([...next], [7]);
  });

  it("does not mutate the input set", () => {
    const input = new Set([1, 2]);
    toggleLineInSet(input, 3);
    assert.deepEqual([...input].sort((a, b) => a - b), [1, 2]);
  });
});

describe("Alt+Click — last-line regression", () => {
  // Reported bug: Alt+Click on the very last line of the test did nothing.
  //
  // Root cause: the previous implementation computed the toggle from
  // editor.getSelections(). Monaco's default mousedown handler runs before
  // our listener and may have already inserted a single-line selection on
  // the clicked line. For non-last lines that selection ended at column 1
  // of the next line, so the toggle correctly saw it as not-yet-present.
  // For the LAST line there is no next line — Monaco's selection was
  // (last,1)→(last,maxCol), the toggle's matches() check considered the
  // line already present, and toggled it off instead of adding it.
  //
  // The fix is to drive the toggle from our own React state (a Set of
  // lines), not from editor.getSelections(). The pure helper's last-line
  // behavior is then identical to any other line.

  it("Alt+Click on the last line (line 7) adds it to the selection", () => {
    const next = toggleLineInSet(new Set([1]), 7);
    assert.deepEqual([...next].sort((a, b) => a - b), [1, 7]);
  });

  it("Alt+Click again on the last line (now selected) removes it", () => {
    const next = toggleLineInSet(new Set([1, 7]), 7);
    assert.deepEqual([...next], [1]);
  });

  it("Alt+Click on the last line when it is the only selected line keeps it selected", () => {
    const next = toggleLineInSet(new Set([7]), 7);
    assert.deepEqual([...next], [7]);
  });
});

describe("Alt+Click line 1 — column-1 boundary regression", () => {
  // Earlier bug: Alt+Click line 1 also highlighted line 2 because Monaco
  // represents "select whole line 1" as a selection ending at (2, 1).
  // getLinesFromSelections must treat that column-1 endpoint as a boundary.
  it("does not include line 2 when Monaco's default selection is (1,1)→(2,1)", () => {
    const monacoDefault = [sel(1, 1, 2, 1)];
    assert.deepEqual([...getLinesFromSelections(monacoDefault, 1)], [1]);
  });
});
