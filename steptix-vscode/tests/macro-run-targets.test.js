/**
 * The macro-file session picker's enumeration
 * (stories/specs/run-and-compile-a-skill-step.md §3.2).
 *
 * Pure rows in, ordered rows out: tests paused/stopped inside the macro
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
  collectMacroRunTargets,
  isMacroDocument,
  samePath,
  macroCallLines,
} from "../src/extension/macro-run-targets.ts";

const ROOT = path.resolve("/proj");
const MACROS = path.join(ROOT, "macros");
const LOGIN = path.join(MACROS, "login.md");

const callerText = (lines) => ["# Caller", "", "## Steps", ...lines, ""].join("\n");

function candidate(over = {}) {
  const { documentText, ...rest } = over;
  return {
    id: "file:///proj/checkout.md",
    testFsPath: path.join(ROOT, "checkout.md"),
    documentText: () => documentText ?? callerText(["1. [macro: login]"]),
    documentClosed: false,
    isRunning: false,
    parkedAtPause: false,
    sessionProbablyOpen: true,
    pausedInMacro: null,
    ...rest,
  };
}

const macrosDirFor = () => MACROS;

test("samePath compares resolved paths, not spellings", () => {
  assert.equal(samePath(LOGIN, LOGIN), true);
  // Built by hand: path.join would collapse the ".." before samePath saw it.
  const roundabout = [MACROS, "..", "macros", "login.md"].join(path.sep);
  assert.notEqual(roundabout, LOGIN);
  assert.equal(samePath(roundabout, LOGIN), true);
  assert.equal(samePath(path.join(MACROS, "logout.md"), LOGIN), false);
});

test("samePath folds drive-letter case on win32", { skip: process.platform !== "win32" }, () => {
  // `uri.fsPath` lower-cases the drive; a server echo may not.
  assert.equal(samePath("C:\\proj\\macros\\login.md", "c:\\proj\\macros\\login.md"), true);
});

// Linux only, not POSIX: on Linux two spellings are two files, so folding
// would merge picker rows for different macros. macOS is left out on purpose —
// its default filesystem is case-insensitive, so whether two spellings name
// one macro there is the filesystem's answer, not this function's to pin.
test("samePath keeps case significant on Linux", { skip: process.platform !== "linux" }, () => {
  assert.equal(samePath("/proj/macros/Login.md", "/proj/macros/login.md"), false);
});

test("isMacroDocument: frontmatter type: macro, any case", () => {
  const text = "---\ntype: Macro\n---\n\n# login\n\n## Steps\n1. x\n";
  assert.equal(isMacroDocument(text, path.join(ROOT, "anywhere.md"), null), true);
});

test("isMacroDocument: frontmatterless file under the macros dir still forks", () => {
  // The server's loadMacro never reads frontmatter — a bare file in macros/
  // is fully invocable, and frontmatter-only detection would silently leave
  // its step commands on standalone behaviour.
  const text = "# login\n\n## Steps\n1. x\n";
  assert.equal(isMacroDocument(text, LOGIN, MACROS), true);
  assert.equal(isMacroDocument(text, path.join(ROOT, "tests", "a.md"), MACROS), false);
  assert.equal(isMacroDocument(text, LOGIN, null), false);
  // The macros dir itself is not "under" the macros dir.
  assert.equal(isMacroDocument(text, MACROS, MACROS), false);
});

test("macroCallLines: a LABELLED call is still a call", () => {
  // Measured against the runtime: `parseMacroCall('Sign in [macro: login]')`
  // returns name=login (the text before the prefix becomes the step's label),
  // so an anchored regex hid those tests from the picker entirely.
  const text = callerText([
    "1. Sign in as admin [macro: login]",
    "2. Do something else",
  ]);
  assert.deepEqual(macroCallLines(text, LOGIN, MACROS), [4]);
});

test("macroCallLines: the colon is optional, as the runtime's separator is", () => {
  // `[macro login]` ≡ `[macro: login]` since the invocation grammar made the
  // separator optional. Measured: the runtime resolves all three of these to
  // `login`, and a colon-requiring regex silently dropped every caller that
  // wrote them — a missing picker row is indistinguishable from a test that
  // does not call the macro at all.
  const text = callerText([
    "1. [macro login]",
    "2. Sign in [macro login]",
    "3. [macro  login]",
  ]);
  assert.deepEqual(macroCallLines(text, LOGIN, MACROS), [4, 5, 6]);
});

test("macroCallLines: declines what the runtime declines", () => {
  // A markdown link and a prose bracket are not calls — the shared parser
  // refuses both, so the picker cannot offer a row the server would then
  // fail to anchor.
  const text = callerText([
    "1. See the [macro guide](./g.md)",
    "2. Verify the [macro level: expert] badge",
  ]);
  assert.deepEqual(macroCallLines(text, LOGIN, MACROS), []);
});

test("macroCallLines: resolves names the way go-to-definition does", () => {
  const text = callerText([
    "1. Open the site",
    "2. [macro: login]",
    '3. [macro: login username="x"]',
    "4. [macro: other]",
    "5. [macro: flows/enter]",
  ]);
  assert.deepEqual(macroCallLines(text, LOGIN, MACROS), [5, 6]);
  assert.deepEqual(
    macroCallLines(text, path.join(MACROS, "flows", "enter.md"), MACROS),
    [8],
  );
  assert.deepEqual(macroCallLines(text, LOGIN, null), []);
});

test("rows come in order: paused, stopped, open callers, standalone", () => {
  const paused = candidate({
    id: "file:///proj/checkout.md",
    testFsPath: path.join(ROOT, "checkout.md"),
    pausedInMacro: { macroFsPath: LOGIN, macroLine: 5, callLine: 4 },
  });
  const stopped = candidate({
    id: "file:///proj/signup.md",
    testFsPath: path.join(ROOT, "signup.md"),
  });
  const open = candidate({
    id: "file:///proj/orders.md",
    testFsPath: path.join(ROOT, "orders.md"),
  });
  const targets = collectMacroRunTargets({
    macroFsPath: LOGIN,
    clickedLine: 5,
    candidates: [open, stopped, paused],
    stopAnchor: { id: "file:///proj/signup.md", macroFsPath: LOGIN, callLine: 4 },
    macrosDirFor,
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
  const targets = collectMacroRunTargets({
    macroFsPath: LOGIN,
    clickedLine: 6,
    candidates: [candidate({ pausedInMacro: { macroFsPath: LOGIN, macroLine: 5, callLine: 4 } })],
    stopAnchor: null,
    macrosDirFor,
  });
  assert.match(targets[0].description, /line 5/);
});

test("a breakpoint-paused test is never a row", () => {
  // Picking one clears its resume marker (runLines posts breakpointStop:null)
  // and supersedes its retained compiler, so the author loses both the ability
  // to Continue and every entry the paused Run & Compile had generated.
  const targets = collectMacroRunTargets({
    macroFsPath: LOGIN,
    clickedLine: 5,
    candidates: [
      candidate({ id: "a", parkedAtPause: true }),
      candidate({
        id: "b",
        parkedAtPause: true,
        pausedInMacro: { macroFsPath: LOGIN, macroLine: 5, callLine: 4 },
      }),
    ],
    stopAnchor: null,
    macrosDirFor,
  });
  assert.deepEqual(targets.map((t) => t.kind), ["standalone"]);
});

test("documentText is read only for rows that are actually scanned", () => {
  let reads = 0;
  const counted = (over) =>
    candidate({ ...over, documentText: undefined, ...{} });
  const anchored = {
    ...counted({ id: "anchored", testFsPath: path.join(ROOT, "a.md") }),
    pausedInMacro: { macroFsPath: LOGIN, macroLine: 5, callLine: 4 },
    documentText: () => {
      reads++;
      return callerText(["1. [macro: login]"]);
    },
  };
  const running = {
    ...counted({ id: "running", testFsPath: path.join(ROOT, "b.md") }),
    isRunning: true,
    documentText: () => {
      reads++;
      return callerText(["1. [macro: login]"]);
    },
  };
  collectMacroRunTargets({
    macroFsPath: LOGIN,
    clickedLine: 5,
    candidates: [anchored, running],
    stopAnchor: null,
    macrosDirFor,
  });
  assert.equal(reads, 0, "an anchored row and a running one are never scanned");
});

test("running and closed-document controllers are never rows", () => {
  // Controllers are never deleted from the registry, so "has a controller"
  // proves nothing — and a mid-run session cannot accept an injected step.
  const targets = collectMacroRunTargets({
    macroFsPath: LOGIN,
    clickedLine: 5,
    candidates: [
      candidate({ id: "a", isRunning: true }),
      candidate({ id: "b", documentClosed: true }),
    ],
    stopAnchor: null,
    macrosDirFor,
  });
  assert.deepEqual(
    targets.map((t) => t.kind),
    ["standalone"],
  );
});

test("the stop anchor is dropped when its controller is gone, and deduped when the same test is paused", () => {
  const pausedSame = candidate({
    pausedInMacro: { macroFsPath: LOGIN, macroLine: 5, callLine: 4 },
  });
  const withGhostAnchor = collectMacroRunTargets({
    macroFsPath: LOGIN,
    clickedLine: 5,
    candidates: [],
    stopAnchor: { id: "file:///proj/gone.md", macroFsPath: LOGIN, callLine: 4 },
    macrosDirFor,
  });
  assert.deepEqual(withGhostAnchor.map((t) => t.kind), ["standalone"]);

  const deduped = collectMacroRunTargets({
    macroFsPath: LOGIN,
    clickedLine: 5,
    candidates: [pausedSame],
    stopAnchor: { id: pausedSame.id, macroFsPath: LOGIN, callLine: 4 },
    macrosDirFor,
  });
  // One row for the test — the ⏸ one; same session either way.
  assert.deepEqual(deduped.map((t) => t.kind), ["paused", "standalone"]);
});

test("an anchored row for ANOTHER macro does not leak into this one's picker", () => {
  const otherMacro = path.join(MACROS, "other.md");
  const targets = collectMacroRunTargets({
    macroFsPath: LOGIN,
    clickedLine: 5,
    candidates: [
      candidate({ pausedInMacro: { macroFsPath: otherMacro, macroLine: 2, callLine: 4 } }),
    ],
    stopAnchor: { id: candidate().id, macroFsPath: otherMacro, callLine: 4 },
    macrosDirFor,
  });
  // The test still shows as an OPEN caller (it does call login) — just not
  // as an anchored row for a macro it is not anchored in.
  assert.deepEqual(targets.map((t) => t.kind), ["open", "standalone"]);
});

test("a test invoking the macro twice yields one open row per call line", () => {
  const twice = candidate({
    documentText: callerText(["1. [macro: login]", "2. Do a thing", "3. [macro: login]"]),
  });
  const targets = collectMacroRunTargets({
    macroFsPath: LOGIN,
    clickedLine: 5,
    candidates: [twice],
    stopAnchor: null,
    macrosDirFor,
  });
  const open = targets.filter((t) => t.kind === "open");
  assert.deepEqual(open.map((t) => t.callLine), [4, 6]);
  assert.match(open[0].description, /via line 4/);
});

test("no probable session, no open row — but standalone always exists", () => {
  const targets = collectMacroRunTargets({
    macroFsPath: LOGIN,
    clickedLine: 5,
    candidates: [candidate({ sessionProbablyOpen: false })],
    stopAnchor: null,
    macrosDirFor,
  });
  assert.deepEqual(targets.map((t) => t.kind), ["standalone"]);
  assert.match(targets[0].label, /standalone/);
});
