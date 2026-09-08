/**
 * The Rows section's pure logic
 * (stories/data-row-progress-and-selection.md §"The Rows section in the
 * Runner panel", §Tests "Panel").
 *
 * Everything the panel decides for itself is here — grouping, the selection
 * algebra, the `runRows` payload, the labels the rest of the panel borrows —
 * so it can be pinned without a DOM. What the panel does NOT decide is
 * equally the point: the values text, the status word and the `detail` all
 * arrive in the host's `rows` message already shaped and masked, and these
 * tests pass them through untouched rather than re-deriving them.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  applyRowClick,
  buildRunRowsPayload,
  buildTableRowsPayload,
  countSelectedRows,
  EMPTY_TABLES,
  formatRowDuration,
  isRowLoopRunning,
  prefixRowFailure,
  rowFailuresFor,
  rowFailurePrefix,
  rowGlyph,
  rowGroups,
  rowKey,
  rowsCollapseKey,
  rowsFor,
  rowStatusClass,
  runButtonLabel,
  runButtonTitle,
  runTableOf,
  runTableRowCount,
  sectionNameOf,
  setRowFailuresFor,
  setRowsFor,
  tableKeyOf,
  variablesHeaderSuffix,
} from "../src/webview/lib/rows-panel.js";

/** A run-table row as the host ships it. */
const row = (n, status, extra = {}) => ({
  row: n,
  line: 10 + n,
  values: `email=user${n}@securebank.com, password=***`,
  status,
  ...extra,
});

const runTable = (statuses, extra = {}) => ({
  table: "run",
  headerLine: 9,
  rows: statuses.map((s, i) => row(i + 1, s)),
  ...extra,
});

const sectionTable = (name, statuses) => ({
  table: { section: name },
  headerLine: 40,
  rows: statuses.map((s, i) => ({
    row: i + 1,
    line: 40 + i + 1,
    values: `file=statement-${i + 1}.pdf`,
    status: s,
  })),
});

const keys = (set) => [...set].sort();

// ── Grouping ──────────────────────────────────────────────────────────────

test("sectionNameOf / tableKeyOf tell the run table from a section table", () => {
  assert.equal(sectionNameOf({ table: "run" }), null);
  assert.equal(sectionNameOf({ table: { section: "Upload each statement" } }), "Upload each statement");
  assert.equal(tableKeyOf({ table: "run" }), "run");
  assert.equal(tableKeyOf({ table: { section: "Upload each statement" } }), "section:Upload each statement");
});

test("rowGroups: the run table alone is labelled Rows (5), with no name", () => {
  const groups = rowGroups([runTable(["passed", "passed", "failed", "passed", "passed"])]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "Rows (5)");
  assert.equal(groups[0].key, "run");
  assert.equal(groups[0].sectionName, null);
});

test("rowGroups: a lone SECTION table also shows no name — nothing to tell it from", () => {
  const groups = rowGroups([sectionTable("Upload each statement", ["pending", "pending", "pending"])]);
  assert.equal(groups[0].label, "Rows (3)");
  // The name is still carried for the payload, only the label drops it.
  assert.equal(groups[0].sectionName, "Upload each statement");
});

test("rowGroups: with more than one table the run table comes first and sections are named", () => {
  const groups = rowGroups([
    runTable(["passed", "passed"]),
    sectionTable("Upload each statement", ["passed", "failed", "skipped"]),
  ]);
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Rows (2)", "Rows · Upload each statement (3)"],
  );
  assert.deepEqual(groups.map((g) => g.key), ["run", "section:Upload each statement"]);
});

test("rowGroups: hasFailed is what puts Re-run failed on a group header", () => {
  const groups = rowGroups([runTable(["passed", "passed"]), sectionTable("S", ["failed"])]);
  assert.equal(groups[0].hasFailed, false);
  assert.equal(groups[1].hasFailed, true);
});

test("rowGroups: no tables, a missing list and a table with no rows are all safe", () => {
  assert.deepEqual(rowGroups([]), []);
  assert.deepEqual(rowGroups(undefined), []);
  const groups = rowGroups([{ table: "run", headerLine: 3, rows: [] }]);
  assert.equal(groups[0].label, "Rows (0)");
  assert.deepEqual(groups[0].rows, []);
});

test("runTableOf finds the run table among sections, and reports its absence", () => {
  const tables = [sectionTable("S", ["passed"]), runTable(["passed"])];
  assert.equal(runTableOf(tables).table, "run");
  assert.equal(runTableOf([sectionTable("S", ["passed"])]), null);
  assert.equal(runTableOf([]), null);
});

test("the collapse key is per FILE as well as per table", () => {
  // The panel is one webview shared by every test, like the Output log and the
  // compile strip. Keyed by the table alone, collapsing Rows on one
  // data-driven test collapsed it on every one of them.
  const [runGroup, sectionGroup] = rowGroups([
    runTable(["passed"]),
    sectionTable("Upload each statement", ["passed"]),
  ]);
  const a = "file:///a.md";
  const b = "file:///b.md";
  assert.notEqual(rowsCollapseKey(a, runGroup.key), rowsCollapseKey(b, runGroup.key));
  assert.notEqual(rowsCollapseKey(a, runGroup.key), rowsCollapseKey(a, sectionGroup.key));
  assert.equal(rowsCollapseKey(a, runGroup.key), rowsCollapseKey(a, runGroup.key));
  // A file the snapshot has not named yet still gets a usable key.
  assert.equal(typeof rowsCollapseKey(undefined, runGroup.key), "string");
});

// ── Marks ─────────────────────────────────────────────────────────────────

test("rowGlyph reuses the Steps list's vocabulary; pending has none", () => {
  assert.equal(rowGlyph("passed"), "✓");
  assert.equal(rowGlyph("failed"), "✗");
  assert.equal(rowGlyph("running"), "…");
  assert.equal(rowGlyph("stopped"), "■");
  assert.equal(rowGlyph("skipped"), "◌");
  assert.equal(rowGlyph("pending"), "");
  assert.equal(rowGlyph(undefined), "");
});

test("rowStatusClass borrows the step colours so a passed row is a passed step's green", () => {
  assert.equal(rowStatusClass("passed"), "tb-step--pass");
  assert.equal(rowStatusClass("failed"), "tb-step--fail");
  assert.equal(rowStatusClass("running"), "tb-step--running");
  assert.equal(rowStatusClass("stopped"), "tb-step--stopped");
  assert.equal(rowStatusClass("skipped"), "tb-step--skip");
  assert.equal(rowStatusClass("pending"), "");
});

test("formatRowDuration matches the report's wording, and shows nothing without one", () => {
  assert.equal(formatRowDuration(8200), "8.2s");
  assert.equal(formatRowDuration(6949), "6.9s");
  assert.equal(formatRowDuration(undefined), "");
  assert.equal(formatRowDuration(null), "");
  assert.equal(formatRowDuration(-1), "");
});

// ── Selection ─────────────────────────────────────────────────────────────

test("plain click on a row replaces the selection, reveals, and starts the steps over", () => {
  const group = rowGroups([runTable(["pending", "pending", "pending"])])[0];
  const out = applyRowClick({ selection: new Set(["run#3"]), group, row: 1 });
  assert.deepEqual(keys(out.selection), ["run#1"]);
  assert.deepEqual(out.anchor, { tableKey: "run", row: 1 });
  assert.equal(out.reveal, true);
  assert.equal(out.clearSteps, true);
});

test("Ctrl/⌘ click toggles a row in, then out, and never touches the step selection", () => {
  const group = rowGroups([runTable(["pending", "pending", "pending"])])[0];
  const added = applyRowClick({ selection: new Set(["run#1"]), group, row: 3, toggle: true });
  assert.deepEqual(keys(added.selection), ["run#1", "run#3"]);
  assert.equal(added.reveal, false);
  assert.equal(added.clearSteps, false);

  const removed = applyRowClick({ selection: added.selection, group, row: 3, toggle: true });
  assert.deepEqual(keys(removed.selection), ["run#1"]);
  // The anchor still moves to the row you clicked, as the Steps list's does.
  assert.deepEqual(removed.anchor, { tableKey: "run", row: 3 });
});

test("Shift+click selects the range from the anchor, in either direction", () => {
  const group = rowGroups([runTable(["pending", "pending", "pending", "pending", "pending"])])[0];
  const down = applyRowClick({
    selection: new Set(), group, row: 4, range: true, anchor: { tableKey: "run", row: 2 },
  });
  assert.deepEqual(keys(down.selection), ["run#2", "run#3", "run#4"]);
  assert.deepEqual(down.anchor, { tableKey: "run", row: 2 }, "the pivot stays put");
  assert.equal(down.clearSteps, false, "a range builds on the selection, so steps survive");

  const up = applyRowClick({
    selection: new Set(), group, row: 2, range: true, anchor: { tableKey: "run", row: 4 },
  });
  assert.deepEqual(keys(up.selection), ["run#2", "run#3", "run#4"]);
});

test("a Shift+click whose anchor is in ANOTHER table falls back to a plain click", () => {
  // A range across two tables would name rows that are not next to each other
  // in any file. Spec: a range is within the same table.
  const section = rowGroups([runTable(["pending"]), sectionTable("S", ["pending", "pending", "pending"])])[1];
  const out = applyRowClick({
    selection: new Set(["run#1"]), group: section, row: 3, range: true, anchor: { tableKey: "run", row: 1 },
  });
  assert.deepEqual(keys(out.selection), ["section:S#3"]);
  assert.deepEqual(out.anchor, { tableKey: "section:S", row: 3 });
});

test("a Shift+click with no anchor yet is a plain click", () => {
  const group = rowGroups([runTable(["pending", "pending"])])[0];
  const out = applyRowClick({ selection: new Set(), group, row: 2, range: true, anchor: null });
  assert.deepEqual(keys(out.selection), ["run#2"]);
  assert.equal(out.clearSteps, true);
});

test("rows of two different tables never collide in the selection", () => {
  const groups = rowGroups([runTable(["pending", "pending"]), sectionTable("S", ["pending", "pending"])]);
  const a = applyRowClick({ selection: new Set(), group: groups[0], row: 2, toggle: true });
  const b = applyRowClick({ selection: a.selection, group: groups[1], row: 2, toggle: true });
  assert.deepEqual(keys(b.selection), ["run#2", "section:S#2"]);
  assert.equal(countSelectedRows(
    [runTable(["pending", "pending"]), sectionTable("S", ["pending", "pending"])],
    b.selection,
  ), 2);
});

test("countSelectedRows ignores an entry for a table the latest rows message no longer has", () => {
  // The `rows` message replaces the file's tables. A leftover key must not
  // inflate `Run (N)` — or reach the payload (see the payload test below).
  const tables = [runTable(["pending", "pending"])];
  const stale = new Set(["run#1", "run#9", "section:Gone#1"]);
  assert.equal(countSelectedRows(tables, stale), 1);
});

// ── The runRows payload ───────────────────────────────────────────────────

test("selected run rows become `rows`, ascending, with no other key", () => {
  const tables = [runTable(["pending", "pending", "pending", "pending", "pending"])];
  const payload = buildRunRowsPayload({ tables, rowSelection: new Set(["run#4", "run#2", "run#3"]) });
  assert.deepEqual(payload, { rows: [2, 3, 4] });
});

test("selected section rows become `sectionRows`, keyed by the name as authored", () => {
  const tables = [runTable(["pending"]), sectionTable("Upload each statement", ["pending", "pending", "pending"])];
  const payload = buildRunRowsPayload({
    tables,
    rowSelection: new Set(["section:Upload each statement#3", "section:Upload each statement#1"]),
  });
  assert.deepEqual(payload, { sectionRows: { "Upload each statement": [1, 3] } });
});

test("a selection spanning rows and steps sends both axes, each sorted", () => {
  const tables = [runTable(["pending", "pending", "pending"])];
  const payload = buildRunRowsPayload({
    tables,
    rowSelection: new Set(["run#2", "run#1"]),
    stepLines: [12, 4, 7],
  });
  assert.deepEqual(payload, { rows: [1, 2], lines: [4, 7, 12] });
});

test("a selection spanning BOTH tables sends rows and sectionRows together", () => {
  const tables = [runTable(["pending", "pending"]), sectionTable("Upload", ["pending", "pending"])];
  const payload = buildRunRowsPayload({
    tables,
    rowSelection: new Set(["run#1", "section:Upload#2"]),
  });
  assert.deepEqual(payload, { rows: [1], sectionRows: { Upload: [2] } });
});

test("an empty axis is left OUT — an absent key means all of it, an empty list means none", () => {
  const tables = [runTable(["pending", "pending"])];
  assert.deepEqual(buildRunRowsPayload({ tables, rowSelection: new Set(), stepLines: [] }), {});
  const rowsOnly = buildRunRowsPayload({ tables, rowSelection: new Set(["run#1"]) });
  assert.equal("lines" in rowsOnly, false);
  assert.equal("sectionRows" in rowsOnly, false);
});

test("a selection key for a row the table no longer has is dropped, not shipped", () => {
  const tables = [runTable(["pending", "pending"])];
  const payload = buildRunRowsPayload({ tables, rowSelection: new Set(["run#1", "run#7"]) });
  assert.deepEqual(payload, { rows: [1] });
});

test("buildTableRowsPayload sends whole rows of one table and never `lines`", () => {
  const [runGroup, sectionGroup] = rowGroups([
    runTable(["failed", "passed", "failed"]),
    sectionTable("Upload each statement", ["passed", "failed", "skipped"]),
  ]);
  // Run this row
  assert.deepEqual(buildTableRowsPayload(runGroup, [3]), { rows: [3] });
  assert.deepEqual(buildTableRowsPayload(sectionGroup, [2]), {
    sectionRows: { "Upload each statement": [2] },
  });
  // Run all
  assert.deepEqual(buildTableRowsPayload(runGroup, [1, 2, 3]), { rows: [1, 2, 3] });
  // …and an arbitrary set, which is all this builder is ever handed.
  assert.deepEqual(buildTableRowsPayload(runGroup, [3, 1]), { rows: [1, 3] });
  assert.deepEqual(buildTableRowsPayload(sectionGroup, [2]), {
    sectionRows: { "Upload each statement": [2] },
  });
});

// ── Labels ────────────────────────────────────────────────────────────────

test("runButtonLabel counts rows and steps together", () => {
  assert.equal(runButtonLabel({ rows: 0, steps: 0 }), "Run");
  // A lone step in a file with NO table still reads plain Run, as it always has.
  assert.equal(runButtonLabel({ rows: 0, steps: 1 }), "Run");
  assert.equal(runButtonLabel({ rows: 0, steps: 3 }), "Run (3)");
  // A lone ROW says so: bare "Run" would read as "run the file".
  assert.equal(runButtonLabel({ rows: 1, steps: 0 }), "Run (1)");
  assert.equal(runButtonLabel({ rows: 3, steps: 2 }), "Run (5)");
  assert.equal(runButtonLabel(undefined), "Run");
});

test("runButtonLabel warns that a step selection is multiplied by the rows", () => {
  // The silent case: a run table, no rows ticked, one step selected — that
  // step runs five times and the button used to say "Run". The multiplier is
  // written differently from `Run (N)` because it is not a count of what is
  // ticked.
  assert.equal(runButtonLabel({ rows: 0, steps: 1, tableRows: 5 }), "Run (×5 rows)");
  assert.equal(runButtonLabel({ rows: 0, steps: 3, tableRows: 5 }), "Run (×5 rows)");
  assert.equal(runButtonLabel({ rows: 0, steps: 1, tableRows: 1 }), "Run (×1 row)");
  // Rows ticked wins: then it IS a count of what is ticked.
  assert.equal(runButtonLabel({ rows: 2, steps: 1, tableRows: 5 }), "Run (3)");
  // Nothing selected at all: the button runs the file, table or no table.
  assert.equal(runButtonLabel({ rows: 0, steps: 0, tableRows: 5 }), "Run");
});

test("runButtonTitle says what the two axes mean together", () => {
  assert.equal(runButtonTitle({ rows: 3, steps: 0 }), "Run 3 selected rows");
  assert.equal(runButtonTitle({ rows: 1, steps: 0 }), "Run 1 selected row");
  assert.equal(runButtonTitle({ rows: 0, steps: 2 }), "Run 2 selected steps");
  assert.equal(
    runButtonTitle({ rows: 2, steps: 1 }),
    "Run 1 selected step for each of 2 selected rows",
  );
  // …including when the rows are not ticked but are there all the same.
  assert.equal(
    runButtonTitle({ rows: 0, steps: 1, tableRows: 5 }),
    "Run 1 selected step for each of 5 rows",
  );
  assert.match(runButtonTitle({ rows: 0, steps: 0 }), /editor cursor/);
});

test("runTableRowCount is the run table's size, and 0 without one", () => {
  assert.equal(runTableRowCount([runTable(["pending", "pending", "pending"])]), 3);
  assert.equal(runTableRowCount([sectionTable("Upload", ["pending", "pending"])]), 0);
  assert.equal(runTableRowCount([]), 0);
  assert.equal(runTableRowCount(undefined), 0);
});

test("the Variables header gains `· row N of M` only while a RUN row is running", () => {
  assert.equal(
    variablesHeaderSuffix([runTable(["passed", "passed", "running", "pending", "pending"])]),
    " · row 3 of 5",
  );
  assert.equal(variablesHeaderSuffix([runTable(["passed", "passed"])]), "");
  // A section iteration is labelled by the Variables view's own frame label.
  assert.equal(variablesHeaderSuffix([sectionTable("Upload", ["running", "pending"])]), "");
  assert.equal(variablesHeaderSuffix([]), "");
});

test("isRowLoopRunning is true only for a running RUN-table row", () => {
  assert.equal(isRowLoopRunning([runTable(["passed", "running"])]), true);
  assert.equal(isRowLoopRunning([runTable(["passed", "failed"])]), false);
  assert.equal(isRowLoopRunning([sectionTable("S", ["running"])]), false);
  assert.equal(isRowLoopRunning([]), false);
});

test("a step's failure text is prefixed with the rows it failed on", () => {
  assert.equal(rowFailurePrefix([3]), "(row 3) ");
  assert.equal(rowFailurePrefix([4, 2]), "(rows 2, 4) ");
  assert.equal(rowFailurePrefix([]), "");
  assert.equal(rowFailurePrefix(undefined), "");
  assert.equal(prefixRowFailure("no such button", [3]), "(row 3) no such button");
  assert.equal(prefixRowFailure("no such button", [2, 4]), "(rows 2, 4) no such button");
  // No rows → the text the panel already shows, byte for byte.
  assert.equal(prefixRowFailure("no such button", undefined), "no such button");
  // Nothing to say stays nothing to say, so the caller renders no block.
  assert.equal(prefixRowFailure(null, [3]), null);
});

// ── Per-file state ────────────────────────────────────────────────────────

test("rows are kept per file, and a message naming no file is dropped", () => {
  const tables = [runTable(["passed"])];
  const one = setRowsFor({}, "file:///a.md", tables);
  const two = setRowsFor(one, "file:///b.md", []);
  assert.equal(rowsFor(two, "file:///a.md"), tables);
  assert.deepEqual(rowsFor(two, "file:///b.md"), []);
  assert.equal(rowsFor(two, "file:///never-ran.md"), EMPTY_TABLES);
  assert.equal(rowsFor(two, undefined), EMPTY_TABLES);
  assert.equal(setRowsFor(two, null, tables), two, "no URI, no bucket");
});

test("a rows message REPLACES the file's tables rather than merging into them", () => {
  const first = setRowsFor({}, "file:///a.md", [runTable(["passed", "passed", "passed"])]);
  const second = setRowsFor(first, "file:///a.md", [runTable(["running", "pending"])]);
  const groups = rowGroups(rowsFor(second, "file:///a.md"));
  assert.equal(groups[0].label, "Rows (2)");
  assert.deepEqual(groups[0].rows.map((r) => r.status), ["running", "pending"]);
});

test("rowSummary folds into a per-file {line → rows} map, sorted", () => {
  const map = setRowFailuresFor({}, "file:///a.md", [
    { line: 42, rows: [4, 2] },
    { line: 7, rows: [3] },
  ]);
  assert.deepEqual(rowFailuresFor(map, "file:///a.md"), { 7: [3], 42: [2, 4] });
  assert.deepEqual(rowFailuresFor(map, "file:///b.md"), {});
  assert.deepEqual(rowFailuresFor(map, undefined), {});
  assert.equal(setRowFailuresFor(map, undefined, []), map);
});

test("rowKey is what keeps the two lists' selections apart", () => {
  assert.equal(rowKey("run", 3), "run#3");
  assert.equal(rowKey("section:Upload each statement", 2), "section:Upload each statement#2");
});

// ── The panel renders what the host said, and nothing else ────────────────

test("the row's values text and detail pass through untouched — the host masks and words them", () => {
  const tables = [{
    table: "run",
    headerLine: 9,
    rows: [
      { row: 1, line: 10, values: "email=demo@securebank.com, password=***", status: "passed", durationMs: 8200 },
      { row: 3, line: 12, values: "email=nobody@securebank.com, password=***", status: "failed", detail: "failed at step 6", durationMs: 7400 },
      { row: 5, line: 14, values: "email=, password=***", status: "skipped", detail: "not run (stopped)" },
    ],
  }];
  const [group] = rowGroups(tables);
  assert.equal(group.rows[0].values, "email=demo@securebank.com, password=***");
  assert.equal(group.rows[1].detail, "failed at step 6");
  assert.equal(formatRowDuration(group.rows[1].durationMs), "7.4s");
  assert.equal(formatRowDuration(group.rows[2].durationMs), "", "a row the loop never reached has no duration");
  // Row numbers are table positions, always (decision 1) — a subset run's
  // rows keep their numbers, so the panel never renumbers what it was sent.
  assert.deepEqual(group.rows.map((r) => r.row), [1, 3, 5]);
  assert.deepEqual(buildTableRowsPayload(group, [3]), { rows: [3] });
});
