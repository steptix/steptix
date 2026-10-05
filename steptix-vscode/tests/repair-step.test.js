/**
 * "Repair this step" — the manifest half.
 *
 * The command's BEHAVIOUR is Compile This Step's, asserted in the integration
 * suite (tests/integration/suite/codebehind.test.cjs) by sending both and
 * comparing the requests. What lives here is the wiring esbuild never
 * typechecks and no unit test would otherwise touch: `contributes.commands`,
 * and the `when` clause that decides which lines the gutter offers it on.
 *
 * That clause carries two decisions worth pinning
 * (stories/codebehind-selector-ambiguity.md §Repair, which already works and
 * cannot be found):
 *
 *  - It appears on a ⚠ line and nowhere else. VS Code puts the clicked line in
 *    `editorLineNumber` for `editor/lineNumber/context` and its `in` operator
 *    does an `includes` against an array-valued key, so
 *    `editorLineNumber in steptix.staleStepLines` is the whole
 *    mechanism — the tracker publishes that array, and a step with no entry or
 *    a passing `</>` one is simply not in it.
 *  - It gates on NOTHING about the session. No "is the browser parked here"
 *    check, no running/paused key. Repair runs from wherever the session is
 *    and lets a wrong page fail the step, exactly as `runStepHere` does. A
 *    session key creeping into this clause is the regression to catch.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.resolve(here, "..", "package.json"), "utf-8"),
);

const COMMAND = "steptix.repairStep";
const COMPILE_STEP = "steptix.compileStepCodeBehind";

/** Menu rows contributed for one command id, in one menu. */
const rowsFor = (menu, command) =>
  (manifest.contributes.menus[menu] ?? []).filter((m) => m.command === command);

test("the command is contributed, with the name the ⚠ is meant to lead to", () => {
  const entry = manifest.contributes.commands.find((c) => c.command === COMMAND);
  assert.ok(entry, `${COMMAND} missing from contributes.commands`);
  // The whole feature is the name: an author looking at ⚠ has no reason to
  // think "Compile This Step" is the fix.
  assert.match(entry.title, /Repair this step/);
});

test("the gutter offers it on a stale line, by asking the stale-lines key", () => {
  const rows = rowsFor("editor/lineNumber/context", COMMAND);
  assert.equal(rows.length, 1, "expected exactly one gutter row for Repair");
  const when = rows[0].when;
  // Per-line visibility has exactly one mechanism in a `when` clause.
  assert.match(when, /editorLineNumber\s+in\s+steptix\.staleStepLines/);
  // Still a Steptix file, like every other row in this menu.
  assert.match(when, /steptix\.activeFile/);
  // …and the stale-lines test is REQUIRED, not one way in among others: a
  // `</>` or plain step, never in that array, must not match. The failure
  // this guards is the clause widened to admit `activeFile` alone (what
  // Compile This Step has, and is right for it) — `activeFile || …` would
  // still contain the stale-lines test, and put Repair on every line.
  assert.doesNotMatch(when, /\|\|/, `Repair's clause must be a plain conjunction: ${when}`);
});

test("nothing in the clause gates on where the session is parked", () => {
  // The decision, in the one place it could be undone by accident. The
  // framework cannot tell whether a page satisfies a natural-language step's
  // precondition, and the provenance that would answer it is not tracked, so
  // Repair refuses nothing about session state — it runs and lets a wrong page
  // fail the step the ordinary way.
  const [gutter] = rowsFor("editor/lineNumber/context", COMMAND);
  const [palette] = rowsFor("commandPalette", COMMAND);
  const forbidden = [
    "steptix.running",
    "steptix.paused",
    "steptix.stepPaused",
    "steptix.skillDebugActive",
    "session",
  ];
  for (const clause of [gutter.when, palette?.when ?? ""]) {
    for (const key of forbidden) {
      assert.equal(
        clause.includes(key),
        false,
        `"${key}" must not gate Repair — it runs from wherever the session is (clause: ${clause})`,
      );
    }
  }
});

test("the palette offers Repair only where something is stale", () => {
  // A `when` clause cannot ask whether an array is empty, and the palette has
  // no line to test against, so the boolean sibling key carries it. Without
  // this the palette would list Repair on a file with nothing to repair.
  const rows = rowsFor("commandPalette", COMMAND);
  assert.equal(rows.length, 1, "expected exactly one palette row for Repair");
  assert.match(rows[0].when, /steptix\.hasStaleStep/);
});

test("Repair leads the gutter's run group, above Compile This Step", () => {
  const [repair] = rowsFor("editor/lineNumber/context", COMMAND);
  const [compile] = rowsFor("editor/lineNumber/context", COMPILE_STEP);
  const order = (row) => {
    const [group, position] = row.group.split("@");
    return { group, position: Number(position) };
  };
  const r = order(repair);
  const c = order(compile);
  assert.equal(r.group, c.group, "both belong to the run group");
  // On a ⚠ line Repair is the answer; Compile This Step is the same call under
  // the name that did not explain itself.
  assert.ok(r.position < c.position, `${r.position} should sort above ${c.position}`);
});
