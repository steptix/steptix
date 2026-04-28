import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getGutterContextMenuItems } from "../src/webview/lib/gutter-menu.js";

describe("getGutterContextMenuItems", () => {
  it("returns no items when no line was right-clicked", () => {
    assert.deepEqual(
      getGutterContextMenuItems({ lineNumber: null, hasBreakpoint: false, running: false }),
      []
    );
  });

  it("includes a Run Test Step item (singular) when 0 or 1 lines are selected", () => {
    for (const selectedLineCount of [0, 1]) {
      const items = getGutterContextMenuItems({ lineNumber: 3, hasBreakpoint: false, running: false, selectedLineCount });
      const labels = items.map((item) => item.label);
      assert.ok(labels.includes("Run Test Step"), `selectedLineCount=${selectedLineCount}: ${JSON.stringify(labels)}`);
      assert.ok(!labels.includes("Run Test Steps"), `selectedLineCount=${selectedLineCount} should not be plural`);
    }
  });

  it("uses Run Test Steps (plural) when 2 or more lines are selected", () => {
    const items = getGutterContextMenuItems({ lineNumber: 3, hasBreakpoint: false, running: false, selectedLineCount: 2 });
    const labels = items.map((item) => item.label);
    assert.ok(labels.includes("Run Test Steps"), `Expected plural in ${JSON.stringify(labels)}`);
    assert.ok(!labels.includes("Run Test Step"));
  });

  it("uses the plural label for non-contiguous selections too (count is what matters)", () => {
    // E.g., user has Alt-clicked lines 2, 5, and 7 — selectedLineCount is 3.
    const items = getGutterContextMenuItems({ lineNumber: 5, hasBreakpoint: false, running: false, selectedLineCount: 3 });
    const runItem = items.find((item) => item.id === "run-step");
    assert.equal(runItem.label, "Run Test Steps");
  });

  it("includes Add Breakpoint when the line has no breakpoint", () => {
    const items = getGutterContextMenuItems({ lineNumber: 3, hasBreakpoint: false, running: false });
    const labels = items.map((item) => item.label);
    assert.ok(labels.includes("Add Breakpoint"));
    assert.ok(!labels.includes("Remove Breakpoint"));
  });

  it("includes Remove Breakpoint when the line already has a breakpoint", () => {
    const items = getGutterContextMenuItems({ lineNumber: 3, hasBreakpoint: true, running: false });
    const labels = items.map((item) => item.label);
    assert.ok(labels.includes("Remove Breakpoint"));
    assert.ok(!labels.includes("Add Breakpoint"));
  });

  it("disables Run Test Step while a run is in progress", () => {
    const items = getGutterContextMenuItems({ lineNumber: 3, hasBreakpoint: false, running: true });
    const runItem = items.find((item) => item.id === "run-step");
    assert.ok(runItem);
    assert.equal(runItem.disabled, true);
  });

  it("keeps the breakpoint toggle enabled while a run is in progress", () => {
    const items = getGutterContextMenuItems({ lineNumber: 3, hasBreakpoint: false, running: true });
    const bpItem = items.find((item) => item.id === "toggle-breakpoint");
    assert.ok(bpItem);
    assert.equal(bpItem.disabled, false);
  });

  it("includes a Clear Statuses item regardless of selection", () => {
    const items = getGutterContextMenuItems({ lineNumber: 3, hasBreakpoint: false, running: false });
    const clearItem = items.find((item) => item.id === "clear-statuses");
    assert.ok(clearItem, "expected a clear-statuses item");
    assert.equal(clearItem.label, "Clear");
    assert.equal(clearItem.disabled, false);
  });

  it("Clear is enabled even when nothing is selected", () => {
    const items = getGutterContextMenuItems({ lineNumber: 3, hasBreakpoint: false, running: false, selectedLineCount: 0 });
    const clearItem = items.find((item) => item.id === "clear-statuses");
    assert.equal(clearItem.disabled, false);
  });

  it("Clear is disabled while a run is in progress", () => {
    // Mid-run, RUNNING entries are about to be replaced — let the run finish
    // (or the user click Stop) before clearing.
    const items = getGutterContextMenuItems({ lineNumber: 3, hasBreakpoint: false, running: true });
    const clearItem = items.find((item) => item.id === "clear-statuses");
    assert.equal(clearItem.disabled, true);
  });
});
