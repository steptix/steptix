/**
 * The skill-file session picker's enumeration
 * (stories/specs/run-and-compile-a-skill-step.md §3.2).
 *
 * Pure rows in, ordered rows out: tests paused/stopped inside the skill
 * first, then open sessions of callers (one row per call line), standalone
 * always last. What is asserted here is the part a wrong answer makes
 * dangerous — a silently-picked session is exactly what the always-a-picker
 * decision exists to prevent, so exclusions (running, closed, gone) and
 * ordering are the substance, not cosmetics.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import path from "node:path";
import {
  collectSkillRunTargets,
  isSkillDocument,
  samePath,
  skillCallLines,
} from "../src/extension/skill-run-targets.ts";

const ROOT = path.resolve("/proj");
const SKILLS = path.join(ROOT, "skills");
const LOGIN = path.join(SKILLS, "login.md");

const callerText = (lines) => ["# Caller", "", "## Steps", ...lines, ""].join("\n");

function candidate(over = {}) {
  return {
    id: "file:///proj/checkout.md",
    testFsPath: path.join(ROOT, "checkout.md"),
    documentText: callerText(["1. [skill: login]"]),
    documentClosed: false,
    isRunning: false,
    sessionProbablyOpen: true,
    pausedInSkill: null,
    ...over,
  };
}

const skillsDirFor = () => SKILLS;

test("samePath folds drive-letter case on win32 only", () => {
  assert.equal(samePath(LOGIN, LOGIN), true);
  if (process.platform === "win32") {
    assert.equal(samePath("C:\\proj\\skills\\login.md", "c:\\proj\\skills\\login.md"), true);
  }
});

test("isSkillDocument: frontmatter type: skill, any case", () => {
  const text = "---\ntype: Skill\n---\n\n# login\n\n## Steps\n1. x\n";
  assert.equal(isSkillDocument(text, path.join(ROOT, "anywhere.md"), null), true);
});

test("isSkillDocument: frontmatterless file under the skills dir still forks", () => {
  // The server's loadSkill never reads frontmatter — a bare file in skills/
  // is fully invocable, and frontmatter-only detection would silently leave
  // its step commands on standalone behaviour.
  const text = "# login\n\n## Steps\n1. x\n";
  assert.equal(isSkillDocument(text, LOGIN, SKILLS), true);
  assert.equal(isSkillDocument(text, path.join(ROOT, "tests", "a.md"), SKILLS), false);
  assert.equal(isSkillDocument(text, LOGIN, null), false);
  // The skills dir itself is not "under" the skills dir.
  assert.equal(isSkillDocument(text, SKILLS, SKILLS), false);
});

test("skillCallLines: resolves names the way go-to-definition does", () => {
  const text = callerText([
    "1. Open the site",
    "2. [skill: login]",
    '3. [skill: login username="x"]',
    "4. [skill: other]",
    "5. [skill: flows/enter]",
  ]);
  assert.deepEqual(skillCallLines(text, LOGIN, SKILLS), [5, 6]);
  assert.deepEqual(
    skillCallLines(text, path.join(SKILLS, "flows", "enter.md"), SKILLS),
    [8],
  );
  assert.deepEqual(skillCallLines(text, LOGIN, null), []);
});

test("rows come in order: paused, stopped, open callers, standalone", () => {
  const paused = candidate({
    id: "file:///proj/checkout.md",
    testFsPath: path.join(ROOT, "checkout.md"),
    pausedInSkill: { skillFsPath: LOGIN, skillLine: 5, callLine: 4 },
  });
  const stopped = candidate({
    id: "file:///proj/signup.md",
    testFsPath: path.join(ROOT, "signup.md"),
  });
  const open = candidate({
    id: "file:///proj/orders.md",
    testFsPath: path.join(ROOT, "orders.md"),
  });
  const targets = collectSkillRunTargets({
    skillFsPath: LOGIN,
    clickedLine: 5,
    candidates: [open, stopped, paused],
    stopAnchor: { id: "file:///proj/signup.md", skillFsPath: LOGIN, callLine: 4 },
    skillsDirFor,
  });
  assert.deepEqual(
    targets.map((t) => t.kind),
    ["paused", "stopped", "open", "standalone"],
  );
  assert.equal(targets[0].callLine, 4);
  assert.match(targets[0].description, /paused at this step/);
  assert.match(targets[1].description, /stopped inside login/);
  assert.match(targets[2].description, /calls login at line 4/);
});

test("a paused anchor at another line says which line, not 'this step'", () => {
  const targets = collectSkillRunTargets({
    skillFsPath: LOGIN,
    clickedLine: 6,
    candidates: [candidate({ pausedInSkill: { skillFsPath: LOGIN, skillLine: 5, callLine: 4 } })],
    stopAnchor: null,
    skillsDirFor,
  });
  assert.match(targets[0].description, /line 5/);
});

test("running and closed-document controllers are never rows", () => {
  // Controllers are never deleted from the registry, so "has a controller"
  // proves nothing — and a mid-run session cannot accept an injected step.
  const targets = collectSkillRunTargets({
    skillFsPath: LOGIN,
    clickedLine: 5,
    candidates: [
      candidate({ id: "a", isRunning: true }),
      candidate({ id: "b", documentClosed: true }),
    ],
    stopAnchor: null,
    skillsDirFor,
  });
  assert.deepEqual(
    targets.map((t) => t.kind),
    ["standalone"],
  );
});

test("the stop anchor is dropped when its controller is gone, and deduped when the same test is paused", () => {
  const pausedSame = candidate({
    pausedInSkill: { skillFsPath: LOGIN, skillLine: 5, callLine: 4 },
  });
  const withGhostAnchor = collectSkillRunTargets({
    skillFsPath: LOGIN,
    clickedLine: 5,
    candidates: [],
    stopAnchor: { id: "file:///proj/gone.md", skillFsPath: LOGIN, callLine: 4 },
    skillsDirFor,
  });
  assert.deepEqual(withGhostAnchor.map((t) => t.kind), ["standalone"]);

  const deduped = collectSkillRunTargets({
    skillFsPath: LOGIN,
    clickedLine: 5,
    candidates: [pausedSame],
    stopAnchor: { id: pausedSame.id, skillFsPath: LOGIN, callLine: 4 },
    skillsDirFor,
  });
  // One row for the test — the ⏸ one; same session either way.
  assert.deepEqual(deduped.map((t) => t.kind), ["paused", "standalone"]);
});

test("an anchored row for ANOTHER skill does not leak into this one's picker", () => {
  const otherSkill = path.join(SKILLS, "other.md");
  const targets = collectSkillRunTargets({
    skillFsPath: LOGIN,
    clickedLine: 5,
    candidates: [
      candidate({ pausedInSkill: { skillFsPath: otherSkill, skillLine: 2, callLine: 4 } }),
    ],
    stopAnchor: { id: candidate().id, skillFsPath: otherSkill, callLine: 4 },
    skillsDirFor,
  });
  // The test still shows as an OPEN caller (it does call login) — just not
  // as an anchored row for a skill it is not anchored in.
  assert.deepEqual(targets.map((t) => t.kind), ["open", "standalone"]);
});

test("a test invoking the skill twice yields one open row per call line", () => {
  const twice = candidate({
    documentText: callerText(["1. [skill: login]", "2. Do a thing", "3. [skill: login]"]),
  });
  const targets = collectSkillRunTargets({
    skillFsPath: LOGIN,
    clickedLine: 5,
    candidates: [twice],
    stopAnchor: null,
    skillsDirFor,
  });
  const open = targets.filter((t) => t.kind === "open");
  assert.deepEqual(open.map((t) => t.callLine), [4, 6]);
  assert.match(open[0].description, /via line 4/);
});

test("no probable session, no open row — but standalone always exists", () => {
  const targets = collectSkillRunTargets({
    skillFsPath: LOGIN,
    clickedLine: 5,
    candidates: [candidate({ sessionProbablyOpen: false })],
    stopAnchor: null,
    skillsDirFor,
  });
  assert.deepEqual(targets.map((t) => t.kind), ["standalone"]);
  assert.match(targets[0].label, /standalone/);
});
