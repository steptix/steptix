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

/**
 * The OTHER producer of a skipped step, and why these two suites sit together.
 *
 * A step that never ran reaches the client two ways: this file's
 * `step:pass` + `output: 'skipped'`, and the `step:skip` event
 * `stories/step-flow-control.md` added, which carries a reason. Neither is
 * going away — the extension is an HTTP client of whichever server the
 * workspace points at, so dropping the older convention would repaint the
 * untaken branch green against a server that had not been restarted.
 *
 * What IS single: the sentence. Both producers print one glyph and one wording
 * (`step-skip-core.ts`, mirrored into `failure-text-inline.js` for the
 * webview). They had already drifted once — `— step 12 skipped` on one path
 * and `◌ step 12 skipped — …` on the other, in adjacent branches of the same
 * `if` — which is exactly what a merge of two features that never met produces
 * and exactly what nobody notices in review.
 */
test("both producers of a skipped step print the one wording", () => {
  const LINE_BUILDERS = /\b(skipRunLogLine|skipCompileLogLine|skipTestOutputLine|skipPanelLine)\s*\(/g;
  for (const rel of Object.keys(CONSUMERS)) {
    const text = fs.readFileSync(path.join(SRC, rel), "utf-8");
    // Each of these files logs or paints; the gutter files paint, so a file
    // with no line builder must be one that only sets a status.
    const builds = countOf(text, LINE_BUILDERS);
    const paints = /skipPaintsOver\s*\(/.test(text);
    assert.ok(
      builds > 0 || paints,
      `${rel} reports a skipped step without using the shared wording or the shared paint rule`,
    );
  }
});

test("no source file hand-rolls a skipped-step sentence", () => {
  // The glyph, or the word, written next to a line number by hand. The two
  // modules that OWN the sentence are the exception.
  const OWNERS = ["extension/step-skip-core.ts", "webview/lib/failure-text-inline.js"];
  const offenders = sourceFiles().filter((rel) => {
    if (OWNERS.includes(rel)) return false;
    const text = fs.readFileSync(path.join(SRC, rel), "utf-8");
    // A template literal that puts `skipped` after an interpolated line
    // number is the shape both drifted copies had.
    return /`[^`]*\$\{[^}]*\.line\}[^`]*skipped/i.test(text);
  });
  assert.deepEqual(offenders, []);
});

test("the paint rule is asked by every path that can write a skip status", () => {
  // A ✗ is the one status a run must not lose, and it is `skipPaintsOver` that
  // says so. Both the `step:skip` handler and the `isSkippedPass` branch of
  // `step:pass` go through it — the second did not, until the two features
  // were merged, so a chain's untaken half could overwrite a red step from an
  // earlier pass through the same body.
  const text = fs.readFileSync(path.join(SRC, "extension/extension.ts"), "utf-8");
  const guards = countOf(text, /skipPaintsOver\s*\(/g);
  const writes = countOf(text, /['"]skip['"]/g);
  assert.ok(
    guards >= 4,
    `extension.ts guards ${guards} skip paints; both gutters have a step:skip AND a ` +
      `step:pass path, so all four must ask (found ${writes} mentions of the status)`,
  );
});
