import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  countStepLineStatuses,
  extractStepLineIds,
  filterToStepLines,
} from "../src/webview/lib/step-lines-inline.js";

const SAMPLE = [
  "# Title",            // 1
  "## Config",          // 2
  "- baseUrl: x",       // 3
  "## Steps",           // 4
  "1. step a",          // 5
  "",                   // 6
  "2. step b",          // 7
  "## Notes",           // 8
  "1. not a step",      // 9
].join("\n");

test("extractStepLineIds: returns numbered list items inside ## Steps only", () => {
  assert.deepEqual(extractStepLineIds(SAMPLE), [5, 7]);
});

test("extractStepLineIds: empty text → []", () => {
  assert.deepEqual(extractStepLineIds(""), []);
});

test("extractStepLineIds: text without ## Steps → []", () => {
  assert.deepEqual(extractStepLineIds("# Title\n\nProse"), []);
});

test("filterToStepLines: drops headings, blank lines, and out-of-section items", () => {
  const allLines = [
    { id: 4, text: "## Steps" },
    { id: 5, text: "1. step a" },
    { id: 6, text: "" },
    { id: 7, text: "2. step b" },
    { id: 8, text: "## Notes" },
    { id: 9, text: "1. not a step" },
  ];
  const got = filterToStepLines(SAMPLE, allLines);
  assert.deepEqual(got.map((s) => s.id), [5, 7]);
});

test("filterToStepLines: preserves step objects exactly (passes through, doesn't rebuild)", () => {
  const allLines = [
    { id: 5, text: "1. step a", extraField: "keep me" },
    { id: 7, text: "2. step b" },
  ];
  const got = filterToStepLines(SAMPLE, allLines);
  assert.equal(got[0].extraField, "keep me");
});

test("filterToStepLines: empty input → []", () => {
  assert.deepEqual(filterToStepLines(SAMPLE, []), []);
});

test("filterToStepLines: only-non-step input → []", () => {
  const allLines = [
    { id: 4, text: "## Steps" },
    { id: 6, text: "" },
    { id: 8, text: "## Notes" },
  ];
  assert.deepEqual(filterToStepLines(SAMPLE, allLines), []);
});

// ─── The panel header's run tally ───────────────────────────────────────────

/** A file with two main-flow steps, one section body step, and a data table
 *  whose rows the host also paints a status on. */
const WITH_ROWS = [
  "# Title",              // 1
  "## Steps",             // 2
  "1. Open the shop",     // 3
  "2. Upload each file",  // 4
  "",                     // 5
  "### Upload each file", // 6
  "| file  |",            // 7
  "| ----- |",            // 8
  "| a.png |",            // 9
  "| b.png |",            // 10
  "| c.png |",            // 11
  "1. Upload {{file}}",   // 12
].join("\n");

test("countStepLineStatuses: counts step lines and ignores data-row lines", () => {
  // The bug this exists for: a Stop part-way through the table leaves rows 2
  // and 3 painted `skip` — which the Rows section below the header calls "not
  // run" — and counting them here rendered "◌ 3 skipped" on a run where one
  // step was skipped and nothing returned three times.
  const statuses = {
    3: "pass",
    4: "pass",
    12: "skip",
    9: "pass",
    10: "skip",
    11: "skip",
  };
  const counts = countStepLineStatuses(statuses, extractStepLineIds(WITH_ROWS));

  assert.equal(counts.pass, 2);
  assert.equal(counts.skip, 1);
  assert.equal(counts.fail, 0);
});

test("countStepLineStatuses: a section body line is a step line, and counts", () => {
  // The other direction: the fix must not narrow the tally to the main flow.
  // `extractStepLineIds` returns body lines too and the header has always
  // counted them.
  const counts = countStepLineStatuses({ 3: "pass", 12: "pass" }, extractStepLineIds(WITH_ROWS));
  assert.equal(counts.pass, 2);
});

test("countStepLineStatuses: every pass flavour is a pass, and is broken down", () => {
  const counts = countStepLineStatuses(
    { 3: "pass-code-behind", 4: "pass-stale", 12: "pass-cached" },
    extractStepLineIds(WITH_ROWS),
  );
  assert.deepEqual(
    { pass: counts.pass, codeBehind: counts.codeBehind, stale: counts.stale },
    { pass: 3, codeBehind: 1, stale: 1 },
  );
});

test("countStepLineStatuses: no statuses at all → all zero", () => {
  assert.deepEqual(countStepLineStatuses({}, []), {
    pass: 0,
    codeBehind: 0,
    stale: 0,
    fail: 0,
    skip: 0,
    // Decision 6 — a step that failed and the run carried on. Deep-equal pins the
    // SHAPE, so a seventh counter the panel header cannot render fails here.
    tolerated: 0,
  });
});
