/**
 * Copy-parity for the inline-section line model.
 *
 * The span scanner is hand-maintained in several places (issues/035). This
 * suite holds this package's copies to the same frozen tables runner-core and
 * the root suite assert against — `fixtures/sections/classification.json` —
 * so a divergence surfaces as a failing row here rather than as a test file
 * that runs one way in the webview and another way in the host.
 *
 * Two distinct obligations, easy to conflate:
 *
 *  - `extractSections` is NEW, and must agree with runner-core exactly.
 *  - `extractStepLineIds` is OLD, and must keep returning main-flow AND body
 *    lines. That is a preservation requirement (contract §5): the webview
 *    paints and anchors by these ids, and a body line is still a line the
 *    user sees. It already holds; these tests stop it being "tidied up" into
 *    main-flow-only to match runner-core's `extractSteps`, which would blank
 *    every section body in the editor.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  extractSections,
  extractStepLineIds,
} from "../src/webview/lib/step-lines-inline.js";
import { extractStepLineIds as hostExtractStepLineIds } from "../src/extension/step-lines.ts";

/**
 * runner-core's SOURCE, not its `dist/`.
 *
 * `npm test` here is a bare `node --test tests/*.test.js` — it builds nothing,
 * so importing `../../runner-core/dist/step-lines.js` asked this suite about
 * whatever the mirror used to be. Measured: putting `if (text) return [];` at
 * the top of `extractSections` in runner-core/src/step-lines.ts and running
 * this file left it 54/54 green. Against the source the same mutation fails
 * 24 of those 54, which is the whole point of a parity suite.
 *
 * Node's type stripping loads the `.ts` directly — as
 * `record-secret-parity.test.js` does for repl.ts, and as the
 * `src/extension/step-lines.ts` import above already does — but step-lines.ts
 * differs from both in one way that decides the shape of this block: it has
 * relative imports of its own (`./section-match.js`, `./control-line.js`), and
 * the stripper does NOT remap a `.js` specifier onto the `.ts` beside it. The
 * import dies in `finalizeResolution` on a file that was never emitted.
 *
 * So the specifier is rewritten on the way through, for exactly that case: a
 * RELATIVE `.js` asked for by a `.ts` file, where the `.ts` twin is on disk.
 * Nothing else is touched, `node --test` gives this file its own process, and
 * the hook is gone with it. The import has to be dynamic — a static one is
 * hoisted above the `registerHooks` call and would resolve before the hook is
 * installed.
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

const { extractSections: coreExtractSections } = await import(
  "../../runner-core/src/step-lines.ts"
);

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "sections",
);
const read = (name) => readFileSync(path.join(FIXTURES, name), "utf-8");
const frozen = JSON.parse(read("classification.json"));
const matchTable = JSON.parse(read("match-table.json"));

// ---------------------------------------------------------------------------
// The [no-hooks] rows of the frozen match table
// ---------------------------------------------------------------------------

/**
 * This mirror reimplements `NO_HOOKS_MARKER` in its cull path, so the marker
 * rows of `match-table.json` apply to it directly — the /i flag and the `\s*`
 * that allows zero separating spaces are both easy to drop in a hand copy.
 *
 * Only the marker rows are meaningful here: the mirror does no name matching,
 * so casefolding and the Turkish-I rows belong to runner-core's suite.
 */
const markerRows = matchTable.rows.filter(
  (row) => /no-hooks/i.test(row.stepRawText) && row.documentExpressible !== false,
);

test("the marker rows are actually present in the frozen table", () => {
  assert.ok(markerRows.length >= 3, `only ${markerRows.length} usable marker rows found`);
});

for (const row of markerRows) {
  test(`marker strip: ${row.name}`, () => {
    // A body step whose entire text is the marker must be culled; one with
    // text after the marker must survive with the marker intact.
    const stripped = row.stepRawText.replace(/^\[no-hooks\]\s*/i, "").trim();
    const text = ["## Steps", "1. Call", "", "### S", `1. ${row.stepRawText}`].join("\n");
    const steps = extractSections(text)[0].steps;

    if (stripped === "") {
      assert.deepEqual(steps, [], "marker-only body item should have been culled");
    } else {
      assert.equal(steps.length, 1);
      assert.equal(steps[0].instruction, row.stepRawText.trim());
    }
  });
}

// ---------------------------------------------------------------------------
// extractSections — must match the frozen table byte for byte
// ---------------------------------------------------------------------------

for (const [fixture, expected] of Object.entries(frozen.files)) {
  test(`extractSections: matches the frozen table for ${fixture}`, () => {
    assert.deepEqual(extractSections(read(fixture)), expected.expectedSections);
  });
}

test("extractSections: a file with no sections yields []", () => {
  const text = ["# T", "## Steps", "1. One", "2. Two"].join("\n");
  assert.deepEqual(extractSections(text), []);
});

test("extractSections: only under a depth-2 Steps heading", () => {
  // Under `### Steps` a `###` closes the span rather than landing in it, so
  // no section exists — and a bare `###`, invisible to the span scanner,
  // must not sneak past that rule either.
  assert.deepEqual(extractSections(["### Steps", "1. One", "", "### S", "1. B"].join("\n")), []);
  assert.deepEqual(extractSections(["### Steps", "1. One", "", "###", "", "1. B"].join("\n")), []);
});

test("extractSections: rejects an indented body item, as runner-core does", () => {
  // The neighbouring STEP_LINE_RE is looser (it allows indentation) and is
  // deliberately left that way; SECTION_STEP_RE is what keeps this mirror
  // aligned with runner-core.
  const text = ["## Steps", "1. Call", "", "### S", "   1. Indented", "2. Real"].join("\n");
  assert.deepEqual(
    extractSections(text)[0].steps.map((s) => s.instruction),
    ["Real"],
  );
});

test("extractSections: culls an item that is empty after the marker strip", () => {
  const text = ["## Steps", "1. Call", "", "### S", "1. [no-hooks]", "2. Real"].join("\n");
  assert.deepEqual(
    extractSections(text)[0].steps.map((s) => s.line),
    [6],
  );
});

test("extractSections: keeps the [no-hooks] marker on a body step verbatim", () => {
  const text = ["## Steps", "1. Call", "", "### S", "1. [no-hooks] Do it"].join("\n");
  assert.equal(extractSections(text)[0].steps[0].instruction, "[no-hooks] Do it");
});

// ---------------------------------------------------------------------------
// Differential: the mirror vs runner-core itself
// ---------------------------------------------------------------------------

/**
 * Asserting both sides against three shared fixtures is not enough on its own
 * — a hazard neither fixture contains is invisible to it. This runs the two
 * implementations against each other over inputs chosen to break them.
 *
 * The frontmatter rows are here because they caught a real bug: the webview's
 * `findStepsSpan` has never skipped frontmatter, so before this was fixed a
 * `---` thematic break made the mirror find sections runner-core did not, and
 * vice versa. All three shared fixtures have frontmatter with no Steps-like
 * content, so every one of them passed either way.
 */
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
  "frontmatter containing a Steps-like line": [
    "---",
    "type: test",
    "# ## Steps",
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
  "leading blanks before frontmatter": ["", "", "---", "a: b", "---", "## Steps", "1. X", "", "### X", "1. Y"],
  "unterminated frontmatter": ["---", "a: b", "", "## Steps", "1. X", "", "### X", "1. Y"],
  "no frontmatter at all": ["## Steps", "1. X", "", "### X", "1. Y"],
  "depth-3 Steps host": ["### Steps", "1. X", "", "### X", "1. Y"],
  "bare ### under a depth-3 Steps host": ["### Steps", "1. X", "", "###", "", "1. Y"],
  "hashes-only headings at three depths": ["## Steps", "1. X", "", "###", "1. A", "", "####", "1. B", "", "#######", "1. C"],
  "inert depth-4 heading inside a body": ["## Steps", "1. X", "", "### S", "1. A", "", "#### Note", "", "2. B"],
  "second Steps heading": ["## Steps", "1. X", "", "### S", "1. A", "", "## Steps", "1. Y", "", "### T", "1. B"],
  "span closed by a depth-1 heading": ["## Steps", "1. X", "", "### S", "1. A", "", "# Other", "1. Z"],
  "multi-digit ordinals and markers": ["## Steps", "1. X", "", "### S", "10. [no-hooks] A", "123. [NO-HOOKS]B", "4. [no-hooks]", "5."],
  "indented body item": ["## Steps", "1. X", "", "### S", "   1. Indented", "2. Real"],
  "no Steps heading": ["# Title", "", "### Login", "1. A"],
  "empty document": [""],
};

for (const [name, lines] of Object.entries(HAZARDS)) {
  for (const [eol, joiner] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
    test(`differential vs runner-core (${eol}): ${name}`, () => {
      const text = lines.join(joiner);
      assert.deepEqual(
        extractSections(text),
        coreExtractSections(text),
        `webview mirror and runner-core disagree on: ${name}`,
      );
    });
  }
}

test("the differential harness can actually detect a disagreement", () => {
  // Without this, a mistake that made both sides return [] for everything
  // would turn every row above into a tautology.
  const text = ["## Steps", "1. Login", "", "### Login", "1. Type"].join("\n");
  assert.equal(extractSections(text).length, 1);
  assert.notDeepEqual(extractSections(text), []);
});

// ---------------------------------------------------------------------------
// extractStepLineIds — PRESERVATION: main + body, in both copies
//
// Main + body, and NOT inert. Line 29 of classification.md sits under the
// depth-4 heading on line 27, so nothing runs it — and these ids drive the
// gutter, the breakpoint gate and the panel's step list, every one of which
// would otherwise offer to run it (contract §5 rule 4a).
// ---------------------------------------------------------------------------

const STEP_LINE_IDS = {
  "classification.md": [13, 17, 18, 24, 25, 33],
  "classification-edge.md": [8, 9, 13, 14, 15, 17, 20, 23],
  "classification-hashes.md": [8, 12, 16, 20],
};

for (const [fixture, expected] of Object.entries(STEP_LINE_IDS)) {
  test(`extractStepLineIds (webview): main + body for ${fixture}`, () => {
    assert.deepEqual(extractStepLineIds(read(fixture)), expected);
  });

  test(`extractStepLineIds (host): main + body for ${fixture}`, () => {
    assert.deepEqual(hostExtractStepLineIds(read(fixture)), expected);
  });
}

test("extractStepLineIds: the two copies agree with each other", () => {
  for (const fixture of Object.keys(frozen.files)) {
    const text = read(fixture);
    assert.deepEqual(
      extractStepLineIds(text),
      hostExtractStepLineIds(text),
      `webview and host disagree on ${fixture}`,
    );
  }
});

test("KNOWN GAP: frontmatter with a column-0 `## Steps` desyncs the two spans", () => {
  // `extractSections` skips frontmatter (matching runner-core); the shipped
  // `extractStepLineIds` never has. A frontmatter block containing a line
  // that is exactly `## Steps` — a legal YAML comment — therefore makes them
  // pick different spans: sections are found, but none of their lines are
  // paintable, so the file shows no gutter, no breakpoints and no run button.
  //
  // Recorded rather than fixed: giving `extractStepLineIds` a frontmatter
  // skip changes decorations on real documents for a case nobody writes, and
  // unifying the span scanners is issues/035. Asserted so the gap is a known
  // quantity instead of a surprise, and so closing it later is a deliberate
  // act that updates this test.
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

  const bodyLines = extractSections(text).flatMap((s) => s.steps.map((step) => step.line));
  assert.deepEqual(bodyLines, [10]);
  assert.deepEqual(extractStepLineIds(text), [], "the gap has closed — update this test");
});

test("extractStepLineIds really is a superset of the main flow", () => {
  // Stated as a property so it survives the fixture being edited: every body
  // line the section model knows about must also be a paintable step id.
  const text = read("classification.md");
  const ids = new Set(extractStepLineIds(text));
  const bodyLines = extractSections(text).flatMap((s) => s.steps.map((step) => step.line));
  assert.ok(bodyLines.length > 0, "fixture defines no body steps");
  for (const line of bodyLines) {
    assert.ok(ids.has(line), `body line ${line} missing from extractStepLineIds`);
  }
});
