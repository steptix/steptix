/**
 * Every surface that branches on `step:pass` asks whether the step actually
 * ran (stories/control-flow.md).
 *
 * The wire has no third verdict, so a step the run decided against — the
 * untaken half of a chain, the body of a `While` that never entered, an
 * `[input:]` the server cannot prompt for inside a section body — arrives as a
 * PASS carrying `output: 'skipped'`. Three of the six consumers were updated
 * for that and three were not, so a compile of a file with a chain painted the
 * untaken branch green, the panel's run log printed "✓ Step on line N passed"
 * and then "skipped" for the same event, and the compile log printed a ✓ for a
 * step that did nothing.
 *
 * The review's own advice was "a grep for `step:pass` is the checklist", so
 * this is that grep, run. It pins two things a unit test of the predicate
 * cannot: that each existing consumer uses it, and that a SEVENTH consumer
 * cannot appear without someone answering the same question.
 *
 * Deliberately a source scan rather than a behavioural test: `run-controller`,
 * `extension` and `test-controller` all import `vscode`, and the panel's
 * handler is a closure inside a React component, so none of the six call sites
 * is reachable from `node --test`. The electron integration suite exercises
 * them for real.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The files that branch on the event today, with how many times each does. */
const CONSUMERS = {
  "extension/extension.ts": 2, // the run gutter, and the compile gutter
  "extension/run-controller.ts": 2, // the compile fold, and the run log
  "extension/test-controller.ts": 1, // Test Explorer's streamed output
  "webview/testbench-runner.jsx": 1, // the panel's run log
};

/**
 * The event name, wherever it is written as a string.
 *
 * Deliberately not `case '…'` / `=== '…'`: a seventh consumer written with
 * `==`, with a lookup table (`{ 'step:pass': … }`), or with the string pulled
 * out into a `const STEP_PASS` would have slipped the very guard this file is
 * (review 3, finding 13). A quoted mention inside a COMMENT would trip the
 * counts too — that is the intended direction: the count changing is a
 * prompt to look, and prose about the event costs one line here to record.
 *
 * Built fresh at each use: a `/g` regex carries `lastIndex` between calls, so
 * a shared one would answer `test()` differently on alternate files.
 */
const branchRe = () => /['"]step:pass['"]/g;

/** Every source file under `src`, relative to it, with forward slashes. */
function sourceFiles(dir = SRC, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...sourceFiles(path.join(dir, entry.name), rel));
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const countOf = (text, re) => (text.match(re) ?? []).length;

test("every file that branches on step:pass calls isSkippedPass", () => {
  for (const [rel, branches] of Object.entries(CONSUMERS)) {
    const text = fs.readFileSync(path.join(SRC, rel), "utf-8");
    assert.equal(countOf(text, branchRe()), branches, `${rel}: branch count changed`);
    assert.ok(
      countOf(text, /isSkippedPass\s*\(/g) >= branches,
      `${rel} branches on step:pass ${branches}× but does not ask isSkippedPass for each — a ` +
        `step that never ran would be painted or logged as a pass`,
    );
  }
});

test("no other source file branches on step:pass unnoticed", () => {
  const branching = sourceFiles().filter(
    (rel) => countOf(fs.readFileSync(path.join(SRC, rel), "utf-8"), branchRe()) > 0,
  );
  assert.deepEqual(branching.sort(), Object.keys(CONSUMERS).sort());
});

test("nobody compares output to the sentinel by hand any more", () => {
  const offenders = sourceFiles().filter((rel) => {
    const text = fs.readFileSync(path.join(SRC, rel), "utf-8");
    // The predicate's own definition is the one place the string may be
    // compared — everywhere else asks it.
    if (rel === "webview/lib/failure-text-inline.js") return false;
    return /\boutput\s*===\s*['"]skipped['"]/.test(text);
  });
  assert.deepEqual(offenders, []);
});
