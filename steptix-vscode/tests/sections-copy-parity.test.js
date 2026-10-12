/**
 * One answer to "which lines are steps?" across this package.
 *
 * The host (`src/extension/step-lines.ts`) and the webview
 * (`src/webview/lib/step-lines-inline.js`, `variables-panel.js`) each used to
 * carry a hand copy of the `## Steps` line grammar. The copies were looser
 * than runner-core's — they took `^\s*\d+\.` — so an indented `  1. Click Save`
 * showed in the gutter while a run never sent it (steptix/steptix#49). Both
 * now take runner-core's answer: the host re-exports `extractStepLineIds`, the
 * webview imports it from `steptix-runner-core/dist/step-lines.js`.
 *
 * What is left to hold together is that wiring, and it can break in two
 * quiet ways this suite catches:
 *
 *  - the webview's import resolves to a stale `dist/`, or to something other
 *    than runner-core — so every row compares the host, the webview, and
 *    runner-core's SOURCE;
 *  - someone reintroduces a local copy "for the webview" — so the rows include
 *    the indentation shapes the old copies got wrong.
 *
 * That the bundled webview can actually call the import is
 * webview-runner-core.test.js's.
 *
 * `extractStepLineIds` must keep returning main-flow AND body lines. That is a
 * preservation requirement (contract §5): the webview paints and anchors by
 * these ids, and a body line is still a line the user sees. These tests stop
 * it being "tidied up" into main-flow-only to match `extractSteps`, which
 * would blank every section body in the editor.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractStepLineIds as webviewExtractStepLineIds } from "../src/webview/lib/step-lines-inline.js";
import { extractStepLineIds as hostExtractStepLineIds } from "../src/extension/step-lines.ts";

/**
 * runner-core's SOURCE, not its `dist/`, so a stale build cannot answer for
 * it: the webview and host both read the compiled copy, and this is what says
 * the compiled copy is current.
 *
 * Node's type stripping loads the `.ts` directly, but step-lines.ts has
 * relative imports of its own (`./section-match.js`, `./control-line.js`), and
 * the stripper does NOT remap a `.js` specifier onto the `.ts` beside it. So
 * the specifier is rewritten on the way through, for exactly that case: a
 * RELATIVE `.js` asked for by a `.ts` file, where the `.ts` twin is on disk.
 * `node --test` gives this file its own process, and the hook is gone with it.
 * The import has to be dynamic — a static one is hoisted above the
 * `registerHooks` call and would resolve before the hook is installed.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      specifier.endsWith(".js") &&
      context.parentURL?.endsWith(".ts") &&
      existsSync(
        fileURLToPath(new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)),
      )
    ) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  extractSections: coreExtractSections,
  extractStepLineIds: coreExtractStepLineIds,
} = await import("../../runner-core/src/step-lines.ts");

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "sections",
);
const read = (name) => readFileSync(path.join(FIXTURES, name), "utf-8");
const frozen = JSON.parse(read("classification.json"));

/** Every copy's answer for `text`, keyed so a failure names the odd one out. */
const answers = (text) => ({
  core: coreExtractStepLineIds(text),
  host: hostExtractStepLineIds(text),
  webview: webviewExtractStepLineIds(text),
});

// ---------------------------------------------------------------------------
// The frozen table — every fixture in it, so a new one is covered by adding it
// ---------------------------------------------------------------------------

/** Main + body lines, from the frozen per-line kinds. Never inert lines. */
const frozenStepLineIds = (file) =>
  file.lines.filter((l) => l.kind === "step" || l.kind === "section-step").map((l) => l.line);

for (const [fixture, expected] of Object.entries(frozen.files)) {
  test(`extractStepLineIds: host, webview and runner-core match the frozen table for ${fixture}`, () => {
    const want = frozenStepLineIds(expected);
    assert.deepEqual(answers(read(fixture)), { core: want, host: want, webview: want });
  });
}

// Hand-written, so the derivation above is not the only thing checking it.
// Line 29 of classification.md sits under the depth-4 heading on line 27, so
// nothing runs it and it is not here (contract §5 rule 4a).
const STEP_LINE_IDS = {
  "classification.md": [13, 17, 18, 24, 25, 33],
  "classification-edge.md": [8, 9, 13, 14, 15, 17, 20, 23],
  "classification-hashes.md": [8, 12, 16, 20],
  // steptix/steptix#49's example: lines 10-14 are indented by two spaces.
  "classification-indented.md": [10, 11, 12, 13, 14, 15, 16],
  "classification-nested.md": [5, 6, 7, 9, 13, 22, 25, 27],
};

for (const [fixture, expected] of Object.entries(STEP_LINE_IDS)) {
  test(`extractStepLineIds: main + body for ${fixture}`, () => {
    assert.deepEqual(answers(read(fixture)), { core: expected, host: expected, webview: expected });
  });
}

// ---------------------------------------------------------------------------
// Differential over shapes chosen to break a copy
// ---------------------------------------------------------------------------

const HAZARDS = {
  "frontmatter containing a column-0 Steps heading": [
    "---",
    "type: test",
    "## Steps",
    "---",
    "",
    "## Steps",
    "1. Login",
    "",
    "### Login",
    "1. Type the username",
  ],
  "--- used as a thematic break, not frontmatter": [
    "# Title",
    "",
    "---",
    "",
    "## Steps",
    "1. Login",
    "",
    "---",
    "",
    "### Login",
    "1. Type",
  ],
  "unterminated frontmatter": ["---", "a: b", "", "## Steps", "1. X", "", "### X", "1. Y"],
  "depth-3 Steps host": ["### Steps", "1. X", "", "### X", "1. Y"],
  "hashes-only headings at three depths": ["## Steps", "1. X", "", "###", "1. A", "", "####", "1. B", "", "#######", "1. C"],
  "inert depth-4 heading inside a body": ["## Steps", "1. X", "", "### S", "1. A", "", "#### Note", "", "2. B"],
  "second Steps heading": ["## Steps", "1. X", "", "### S", "1. A", "", "## Steps", "1. Y", "", "### T", "1. B"],
  "span closed by a depth-1 heading": ["## Steps", "1. X", "", "### S", "1. A", "", "# Other", "1. Z"],
  "indented main-flow steps": ["## Steps", "  1. A", "  2. B", "3. C"],
  "one space, and a tab": ["## Steps", " 1. A", "\t2. Nested under A", "3. B"],
  "a nested sub-list": ["## Steps", "1. A", "   1. a1", "   2. a2", "2. B"],
  "two spaces under `1. ` is a sibling": ["## Steps", "1. A", "  2. B"],
  "three spaces under `10. ` is a sibling": ["## Steps", "10. A", "   11. B"],
  "four spaces at the top level": ["## Steps", "    1. Code", "    2. Code"],
  "indented body item": ["## Steps", "1. X", "", "### S", "   1. Indented", "2. Real"],
  "no Steps heading": ["# Title", "", "### Login", "1. A"],
  "empty document": [""],
};

for (const [name, lines] of Object.entries(HAZARDS)) {
  for (const [eol, joiner] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
    test(`host and webview agree with runner-core (${eol}): ${name}`, () => {
      const got = answers(lines.join(joiner));
      assert.deepEqual(got.host, got.core, `host disagrees with runner-core on: ${name}`);
      assert.deepEqual(got.webview, got.core, `webview disagrees with runner-core on: ${name}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Behaviour this change made on purpose
// ---------------------------------------------------------------------------

test("an indented step is one the editor shows AND a run sends", () => {
  // The bug: the editor's copy took `^\s*\d+\.`, a run took `^\d+\.`, so the
  // gutter drew a status cell on line 2 and the run started on line 4.
  const text = ["## Steps", "  1. Open the start page", "  2. Type \"Ada\"", "3. Click Next"].join("\n");
  assert.deepEqual(answers(text), { core: [2, 3, 4], host: [2, 3, 4], webview: [2, 3, 4] });
});

test("a nested numbered item is not a step in the editor either", () => {
  // The old editor copy marked it, and the CLI folds it into the step above.
  const text = ["## Steps", "1. Fill the form", "   1. Type the name", "2. Submit"].join("\n");
  assert.deepEqual(answers(text), { core: [2, 4], host: [2, 4], webview: [2, 4] });
});

test("an indented body item is a body step (it used to be refused)", () => {
  // Expectation changed with steptix/steptix#49. Under the old strict rule
  // runner-core dropped `   1. Indented` while the CLI's markdown parser ran
  // it — and because the file defines a section the CLI then refused it with
  // a step/line mismatch. Markdown's rule makes it a step everywhere.
  const text = ["## Steps", "1. Call", "", "### S", "   1. Indented", "2. Real"].join("\n");
  assert.deepEqual(
    coreExtractSections(text)[0].steps.map((s) => s.instruction),
    ["Indented", "Real"],
  );
  assert.deepEqual(answers(text), { core: [2, 5, 6], host: [2, 5, 6], webview: [2, 5, 6] });
});

test("frontmatter is skipped: a `## Steps` line inside it no longer hides the file's steps", () => {
  // This was the KNOWN GAP test. `extractStepLineIds` had never skipped
  // frontmatter while `extractSections` did, so a frontmatter line that was
  // exactly `## Steps` (a legal YAML comment) made the two pick different
  // spans: sections were found, but none of their lines could be painted —
  // no gutter, no breakpoints, no Run button. The gap closed on purpose with
  // steptix/steptix#49, when the editor started taking runner-core's answer:
  // only files with that line in their frontmatter change, and they change
  // from "nothing shows" to "the steps show".
  const text = [
    "---",
    "type: test",
    "## Steps",
    "---",
    "",
    "## Steps",
    "1. Login",
    "",
    "### Login",
    "1. Type the username",
  ].join("\n");

  const bodyLines = coreExtractSections(text).flatMap((s) => s.steps.map((step) => step.line));
  assert.deepEqual(bodyLines, [10]);
  assert.deepEqual(answers(text), { core: [7, 10], host: [7, 10], webview: [7, 10] });
});

test("extractStepLineIds really is a superset of the section bodies", () => {
  // Stated as a property so it survives the fixture being edited: every body
  // line the section model knows about must also be a paintable step id.
  for (const fixture of ["classification.md", "classification-nested.md"]) {
    const text = read(fixture);
    const ids = new Set(webviewExtractStepLineIds(text));
    const bodyLines = coreExtractSections(text).flatMap((s) => s.steps.map((step) => step.line));
    assert.ok(bodyLines.length > 0, `${fixture} defines no body steps`);
    for (const line of bodyLines) {
      assert.ok(ids.has(line), `body line ${line} of ${fixture} missing from extractStepLineIds`);
    }
  }
});
