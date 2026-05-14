import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldSnapshotSelection,
  getSelectionsToRestore,
} from "../src/webview/lib/gutter-rightclick.js";

describe("shouldSnapshotSelection", () => {
  it("returns true for right-click (button 2)", () => {
    assert.equal(shouldSnapshotSelection(2), true);
  });

  it("returns false for left-click (button 0)", () => {
    assert.equal(shouldSnapshotSelection(0), false);
  });

  it("returns false for middle-click (button 1)", () => {
    assert.equal(shouldSnapshotSelection(1), false);
  });

  it("returns false for back/forward buttons (3, 4)", () => {
    assert.equal(shouldSnapshotSelection(3), false);
    assert.equal(shouldSnapshotSelection(4), false);
  });
});

describe("getSelectionsToRestore", () => {
  it("returns null for null or undefined input", () => {
    assert.equal(getSelectionsToRestore(null), null);
    assert.equal(getSelectionsToRestore(undefined), null);
  });

  it("returns null for an empty array (no prior selection to restore)", () => {
    assert.equal(getSelectionsToRestore([]), null);
  });

  it("returns null for a non-array input", () => {
    assert.equal(getSelectionsToRestore({}), null);
    assert.equal(getSelectionsToRestore("foo"), null);
  });

  it("returns the array when at least one selection was captured", () => {
    const selections = [
      { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 30 },
      { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 30 },
    ];
    assert.strictEqual(getSelectionsToRestore(selections), selections);
  });
});

describe("Right-click on gutter — full bug-report scenario", () => {
  // Reported bug: with two or more lines selected, right-clicking on the
  // gutter caused those lines to become unselected. The fix is to snapshot
  // the editor's selections during the capture-phase mousedown (only when
  // the button is right-click) and restore them after the context menu
  // opens. The two pure helpers encode each decision.

  it("a right-click with a multi-line selection produces a snapshot that will be restored", () => {
    const button = 2;
    const liveSelections = [
      { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 50 },
      { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 50 },
    ];

    // Step 1: capture-phase mousedown decides whether to snapshot.
    const willSnapshot = shouldSnapshotSelection(button);
    assert.equal(willSnapshot, true);
    const snapshot = willSnapshot ? liveSelections : null;

    // Step 2: after the context menu opens, decide whether to restore.
    const toRestore = getSelectionsToRestore(snapshot);
    assert.strictEqual(toRestore, liveSelections);
    assert.equal(toRestore.length, 2);
  });

  it("a left-click does not snapshot, so nothing is queued for restore", () => {
    const button = 0;
    const liveSelections = [
      { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 50 },
    ];

    const willSnapshot = shouldSnapshotSelection(button);
    assert.equal(willSnapshot, false);
    const snapshot = willSnapshot ? liveSelections : null;

    assert.equal(getSelectionsToRestore(snapshot), null);
  });

  it("a right-click with no prior selection has nothing to restore", () => {
    // The editor always has at least a cursor, so getSelections() returns a
    // single zero-width selection. Even so, this exercises the "no live
    // selection at all" branch (e.g., editor not focused yet).
    const button = 2;
    assert.equal(shouldSnapshotSelection(button), true);
    assert.equal(getSelectionsToRestore(null), null);
    assert.equal(getSelectionsToRestore([]), null);
  });
});
