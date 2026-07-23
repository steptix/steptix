/**
 * The two pure helpers behind sectioned runs: the request payload and the
 * pre-flight that refuses a file the CLI would reject.
 *
 * These matter because they are the client's half of a contract nothing in
 * the type system enforces. The server validates what it receives, but a
 * section lost HERE — dropped from the payload, or a bad name waved through —
 * never reaches that validation at all.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildSectionsPayload,
  preflightSections,
  sectionedSkillRefusal,
} from "../src/extension/sections.ts";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "sections",
);
const read = (name) => readFileSync(path.join(FIXTURES, name), "utf-8");

const doc = (...lines) => lines.join("\n");

// ---------------------------------------------------------------------------
// buildSectionsPayload
// ---------------------------------------------------------------------------

test("payload: null when the file defines no sections", () => {
  // NOT `{}`. An empty map is truthy, and the server's gates read the field
  // directly — sending one would move every sectionless run onto the
  // expansion path, changing behaviour for tests unrelated to this feature.
  assert.equal(buildSectionsPayload(doc("## Steps", "1. One", "2. Two")), null);
  assert.equal(buildSectionsPayload(""), null);
});

test("payload: keyed by match text, with the authored name preserved", () => {
  const payload = buildSectionsPayload(
    doc("## Steps", "1. Sign In", "", "### Sign In", "1. Type creds", "2. Submit"),
  );
  assert.deepEqual(Object.keys(payload), ["sign in"]);
  assert.deepEqual(payload["sign in"], {
    name: "Sign In",
    headingLine: 4,
    steps: ["Type creds", "Submit"],
    stepLines: [5, 6],
  });
});

test("payload: steps and stepLines stay parallel", () => {
  // The server 400s on a skew, because a mismatch attributes a body step to
  // the wrong source line — wrong gutter, wrong breakpoint, wrong re-run
  // anchor.
  for (const fixture of ["classification.md", "classification-edge.md"]) {
    const payload = buildSectionsPayload(read(fixture));
    for (const [key, entry] of Object.entries(payload ?? {})) {
      assert.equal(entry.steps.length, entry.stepLines.length, `${fixture} / ${key}`);
    }
  }
});

test("payload: [no-hooks] markers travel verbatim", () => {
  // The expander strips them when inlining. Stripping here as well would
  // hide a body step's opt-out from the server's hook logic.
  const payload = buildSectionsPayload(
    doc("## Steps", "1. S", "", "### S", "1. [no-hooks] Do it"),
  );
  assert.deepEqual(payload["s"].steps, ["[no-hooks] Do it"]);
});

test("payload: a section named __proto__ survives", () => {
  // `payload['__proto__'] = entry` on an object literal invokes the
  // prototype setter: the entry vanishes and the map's prototype is
  // replaced. That loss happens BEFORE the request is sent, where none of
  // the server's validation can see it.
  const payload = buildSectionsPayload(
    doc("## Steps", "1. __proto__", "", "### __proto__", "1. Body ran"),
  );
  assert.deepEqual(Object.keys(payload), ["__proto__"]);
  assert.deepEqual(payload["__proto__"].steps, ["Body ran"]);
});

test("payload: matches the frozen fixture's sections", () => {
  const frozen = JSON.parse(read("classification.json")).files["classification.md"];
  const payload = buildSectionsPayload(read("classification.md"));
  assert.deepEqual(
    Object.values(payload).map((s) => ({
      name: s.name,
      headingLine: s.headingLine,
      steps: s.steps,
    })),
    frozen.expectedSections.map((s) => ({
      name: s.name,
      headingLine: s.headingLine,
      steps: s.steps.map((x) => x.instruction),
    })),
  );
});

// ---------------------------------------------------------------------------
// preflightSections
// ---------------------------------------------------------------------------

test("preflight: passes a clean file, and a file with no sections", () => {
  assert.equal(preflightSections(read("classification.md")), null);
  assert.equal(preflightSections(doc("## Steps", "1. One")), null);
});

test("preflight: refuses a duplicate name, case-insensitively", () => {
  // The wire format CANNOT represent a duplicate — a JSON object collapses
  // them, last one wins — so the CLI would refuse this file while TestBench
  // ran it with a different definition.
  const problem = preflightSections(
    doc("## Steps", "1. Login", "", "### Login", "1. A", "", "### LOGIN", "1. B"),
  );
  assert.match(problem, /duplicate section "LOGIN"/i);
  assert.match(problem, /already defined at line 4/);
});

test("preflight: refuses reserved, bracket-prefixed and interpolated names", () => {
  assert.match(
    preflightSections(doc("## Steps", "1. C", "", "### Steps", "1. A")),
    /reserved section keyword/i,
  );
  assert.match(
    preflightSections(doc("## Steps", "1. C", "", "### [skill: x]", "1. A")),
    /may not begin with/i,
  );
  assert.match(
    preflightSections(doc("## Steps", "1. C", "", "### Login {{user}}", "1. A")),
    /may not contain/i,
  );
});

test("preflight: refuses a hashes-only heading", () => {
  // Reachable only because the line model classifies a bare `###` as a
  // section heading with an empty name. Left as prose it would be invisible
  // here, and TestBench would run the body below as main-flow steps while
  // the CLI refused the file — the exact divergence this check exists for.
  const problem = preflightSections(read("classification-hashes.md"));
  assert.match(problem, /empty name/i);
});

test("preflight: reports the offending line", () => {
  const problem = preflightSections(
    doc("## Steps", "1. C", "", "### Fine", "1. A", "", "### Steps", "1. B"),
  );
  assert.match(problem, /^Line 7:/);
});

test("preflight and payload agree about which files are runnable", () => {
  // A file the pre-flight passes must produce a payload the server accepts,
  // and vice versa — otherwise one of them is deciding something the other
  // does not know about.
  for (const fixture of ["classification.md", "classification-edge.md"]) {
    assert.equal(preflightSections(read(fixture)), null, fixture);
    assert.notEqual(buildSectionsPayload(read(fixture)), null, fixture);
  }
  // The hashes fixture is refused, so its payload is never sent.
  assert.notEqual(preflightSections(read("classification-hashes.md")), null);
});

// ---------------------------------------------------------------------------
// sectionedSkillRefusal
// ---------------------------------------------------------------------------

test("refusal: a skill that defines sections cannot be line-anchored", () => {
  // Line anchors into a skill file assume document order matches execution
  // order there. A skill with its own sections breaks that — its bodies sit
  // below its main flow but execute wherever called — and the server applies
  // exact matching only to the TEST file, so a skill anchor falls back to
  // nearest-line and can land inside a body that already ran. Measured: a
  // re-run from a skill's last step re-executed two passed body steps.
  const dir = mkdtempSync(path.join(tmpdir(), "sections-refusal-"));
  const skill = path.join(dir, "sectioned.md");
  writeFileSync(
    skill,
    ["---", "type: skill", "---", "# sectioned", "", "## Steps", "1. First", "2. Helper", "", "### Helper", "1. Body"].join("\n"),
  );

  const problem = sectionedSkillRefusal({
    kind: "skill",
    skillUri: skill,
    skillName: "sectioned",
  });
  assert.match(problem ?? "", /defines inline sections/i);
  assert.match(problem ?? "", /sectioned/);

  rmSync(dir, { recursive: true, force: true });
});

test("refusal: a plain skill is still re-runnable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sections-refusal-"));
  const skill = path.join(dir, "plain.md");
  writeFileSync(
    skill,
    ["---", "type: skill", "---", "# plain", "", "## Steps", "1. First", "2. Second"].join("\n"),
  );
  assert.equal(
    sectionedSkillRefusal({ kind: "skill", skillUri: skill, skillName: "plain" }),
    null,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("refusal: a SECTION failure is never refused by this check", () => {
  // For a section failure `skillUri` IS the test file, which by definition
  // defines sections. A kind-blind check would refuse every section re-run —
  // the exact flow this feature adds.
  const dir = mkdtempSync(path.join(tmpdir(), "sections-refusal-"));
  const test_ = path.join(dir, "t.md");
  writeFileSync(test_, ["## Steps", "1. Helper", "", "### Helper", "1. Body"].join("\n"));
  assert.equal(
    sectionedSkillRefusal({ kind: "section", skillUri: test_, skillName: "Helper" }),
    null,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("refusal: an unreadable skill file does not invent an error", () => {
  // Let the normal flow fail with its own message rather than blaming
  // sections for a missing file.
  assert.equal(
    sectionedSkillRefusal({
      kind: "skill",
      skillUri: path.join(tmpdir(), "definitely-not-here-9e1f.md"),
      skillName: "gone",
    }),
    null,
  );
});
