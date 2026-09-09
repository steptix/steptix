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
 *
 * Counted per CALL SITE, not per file. The first version of this test asked
 * only "does this file mention a shared builder at all", which three of four
 * skip lines using one and a fourth hand-rolling its own would have passed.
 * The counts are exact for the same reason `branchRe` above is exact: a number
 * changing is a prompt to look, and a fifth skip line added without the shared
 * wording changes one.
 */
const LINE_BUILDER_SITES = {
  // the compile fold's two (one per producer), and the run log's two
  "extension/run-controller.ts": 4,
  // Test Explorer's two, one per producer
  "extension/test-controller.ts": 2,
  // the panel's two, one per producer
  "webview/testbench-runner.jsx": 2,
  // paints a status, logs nothing
  "extension/extension.ts": 0,
};

test("both producers of a skipped step print the one wording", () => {
  const LINE_BUILDERS = /\b(skipRunLogLine|skipCompileLogLine|skipTestOutputLine|skipPanelLine)\s*\(/g;
  for (const [rel, expected] of Object.entries(LINE_BUILDER_SITES)) {
    const text = fs.readFileSync(path.join(SRC, rel), "utf-8");
    const builds = countOf(text, LINE_BUILDERS);
    assert.equal(
      builds,
      expected,
      `${rel} calls a shared skip-line builder ${builds}× where ${expected} were expected — a ` +
        `skip line added without one, or removed, is how the two producers drifted last time`,
    );
    // A file that reports a skipped step does so through the shared wording or
    // the shared paint rule. Never neither.
    assert.ok(
      builds > 0 || /skipPaintsOver\s*\(/.test(text),
      `${rel} reports a skipped step without using the shared wording or the shared paint rule`,
    );
  }
  assert.deepEqual(
    Object.keys(LINE_BUILDER_SITES).sort(),
    Object.keys(CONSUMERS).sort(),
    "the two tables cover the same files",
  );
});

test("no source file hand-rolls a skipped-step sentence", () => {
  // The glyph, or the word, written next to a line or step number by hand.
  // The two modules that OWN the sentence are the exception.
  //
  // The first version of this scan looked for `${….line}` inside a template
  // literal ending in "skipped", which catches one drift shape in eight: it
  // missed a destructured `line`, string concatenation, "skipped step N" word
  // order, and — measured — the Runner UI's own `— Step ${data.stepIndex}
  // skipped`, which was live at the time. So the shape asked for now is the
  // loose one: the word "skipped" and an interpolation, on one line, in a
  // template literal or a concatenation. False positives are cheap (add the
  // file to OWNERS with a reason); a miss is what this test exists to prevent.
  const OWNERS = ["extension/step-skip-core.ts", "webview/lib/failure-text-inline.js"];
  /** A quoted or backticked run of text on this line. */
  const HAS_LITERAL = /[`'"]/;
  /** A value dropped into it — `${…}`, or string concatenation. */
  const HAS_VALUE = [/\$\{/, /['"`]\s*\+/, /\+\s*['"`]/];
  const offenders = sourceFiles().filter((rel) => {
    if (OWNERS.includes(rel)) return false;
    const text = fs.readFileSync(path.join(SRC, rel), "utf-8");
    return text.split(/\r?\n/).some(
      (line) =>
        HAS_LITERAL.test(line) &&
        /\bskipped\b/i.test(line) &&
        // A TALLY says "3 skipped" and names no step — `stepsSummaryText` and
        // the batch summary are allowed to, and are not what drifted. What
        // drifted was the per-step SENTENCE, which always addresses one step
        // or one line by number.
        /\b(step|line)\b/i.test(line) &&
        HAS_VALUE.some((re) => re.test(line)),
    );
  });
  assert.deepEqual(offenders, []);
});

test("the paint rule is asked by every path that can write a skip status", () => {
  // A ✗ is the one status a run must not lose, and it is `skipPaintsOver` that
  // says so. Both the `step:skip` handler and the `isSkippedPass` branch of
  // `step:pass` go through it — the second did not, until the two features
  // were merged, so a chain's untaken half could overwrite a red step from an
  // earlier pass through the same body.
  //
  // An EQUALITY against the paths that can write one, not a floor: `>= 4`
  // passed just as happily with a fifth `setStatus(…, 'skip', …)` added and
  // left unguarded. A skip-bearing path is an `isSkippedPass` branch or a
  // `step:skip` case; each must ask the paint rule exactly once.
  const text = fs.readFileSync(path.join(SRC, "extension/extension.ts"), "utf-8");
  const guards = countOf(text, /skipPaintsOver\s*\(/g);
  const paths =
    countOf(text, /isSkippedPass\s*\(/g) + countOf(text, /case ['"]step:skip['"]/g);
  assert.equal(
    guards,
    paths,
    `extension.ts has ${paths} paths that can write a skip status but guards ${guards} of ` +
      `them with skipPaintsOver — an unguarded one can overwrite a ✗, the single status a ` +
      `run must not lose`,
  );
  assert.equal(paths, 4, "both gutters have a step:skip AND a step:pass path");
});
