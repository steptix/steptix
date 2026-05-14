import { test } from "node:test";
import { strict as assert } from "node:assert";
import { extractStepLineIds, filterToStepLines } from "../src/webview/lib/step-lines-inline.js";

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
