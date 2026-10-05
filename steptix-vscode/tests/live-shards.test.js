// Unit coverage for the parallel live runner's plumbing
// (tests/integration/liveShards.cjs).
//
// These are the pieces whose bugs are invisible from a live run: a workspace
// copy that brings a stale `.steps.ts` along makes a compile assertion pass
// for the wrong reason, and a pool that hands two items to one worker just
// looks like a slow afternoon. Everything here is pure or filesystem-only —
// no VS Code, no server, no browser.
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  copyWorkspace,
  rebaseConfigPaths,
  pointEnvAtServer,
  liveAiProblem,
  scheduleOrder,
  runPool,
  sharedServerStatsWarning,
} = require("../tests/integration/liveShards.cjs");

/** A fresh temp dir, removed when the file is done. `maxRetries`: on Windows
 *  antivirus or the indexer can still hold a file written moments ago, and
 *  `force` does not cover EBUSY/EPERM. */
const made = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-shards-"));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

// ─── scheduleOrder ──────────────────────────────────────────────────────────

test("scheduleOrder: slowest known file first", () => {
  const order = scheduleOrder(
    ["fast.test.cjs", "slow.test.cjs", "middling.test.cjs"],
    { "fast.test.cjs": 5_000, "slow.test.cjs": 300_000, "middling.test.cjs": 60_000 },
  );
  assert.deepEqual(order, ["slow.test.cjs", "middling.test.cjs", "fast.test.cjs"]);
});

test("scheduleOrder: a file with no recorded time goes ahead of every known one", () => {
  // Assumed slow, deliberately: guessing "fast" and being wrong strands a long
  // file at the end of the queue with every worker waiting on it, while
  // guessing "slow" and being wrong costs one worker a short early task.
  const order = scheduleOrder(
    ["known-slow.test.cjs", "brand-new.test.cjs"],
    { "known-slow.test.cjs": 300_000 },
  );
  assert.deepEqual(order, ["brand-new.test.cjs", "known-slow.test.cjs"]);
});

test("scheduleOrder: with nothing remembered the order is stable, not arbitrary", () => {
  const order = scheduleOrder(["b.test.cjs", "a.test.cjs", "c.test.cjs"], {});
  assert.deepEqual(order, ["a.test.cjs", "b.test.cjs", "c.test.cjs"]);
});

test("scheduleOrder: does not mutate the caller's list", () => {
  const files = ["a.test.cjs", "b.test.cjs"];
  scheduleOrder(files, { "b.test.cjs": 99 });
  assert.deepEqual(files, ["a.test.cjs", "b.test.cjs"]);
});

// ─── runPool ────────────────────────────────────────────────────────────────

test("runPool: every item runs exactly once, and never more than N at a time", async () => {
  const workers = [{ index: 1 }, { index: 2 }];
  const items = Array.from({ length: 9 }, (_, i) => `item-${i}`);
  const seen = [];
  let inFlight = 0;
  let peak = 0;

  await runPool(workers, items, async (worker, item) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    seen.push(item);
    inFlight--;
  });

  assert.equal(seen.length, items.length);
  assert.deepEqual([...seen].sort(), [...items].sort());
  assert.equal(peak, workers.length, `at most ${workers.length} in flight, saw ${peak}`);
});

test("runPool: a free worker takes the next item rather than waiting its turn", async () => {
  // The whole reason for a pull queue. One long item and four short ones over
  // two workers: a pre-computed split could give one worker the long item AND
  // two short ones; pulling means the fast worker drains the short ones while
  // the other is still on the long one.
  //
  // "Long" is not a duration: the long item lasts until every short one is
  // done. Timers cannot be trusted to order it — Windows rounds a 1 ms timer
  // up to its ~15 ms tick, so four "short" ones can outlast a 60 ms one. A
  // split that queued short items behind the long one would never finish
  // them; the backstop releases it so that fails on the assertion, not by
  // hanging.
  const workers = [{ index: 1 }, { index: 2 }];
  const byWorker = new Map();
  let releaseLong;
  const longEnds = new Promise((r) => (releaseLong = r));
  const backstop = setTimeout(() => releaseLong(), 10_000);
  let shortsDone = 0;

  await runPool(workers, ["long", "a", "b", "c", "d"], async (worker, item) => {
    if (item === "long") {
      await longEnds;
    } else {
      await new Promise((r) => setTimeout(r, 1));
      if (++shortsDone === 4) releaseLong();
    }
    const list = byWorker.get(worker.index) ?? [];
    list.push(item);
    byWorker.set(worker.index, list);
  });
  clearTimeout(backstop);

  const longWorker = [...byWorker.entries()].find(([, items]) => items.includes("long"))[0];
  assert.deepEqual(
    byWorker.get(longWorker),
    ["long"],
    "the worker on the long item should not have picked up any short ones",
  );
});

test("runPool: a throwing task rejects the pool — the caller must catch its own", async () => {
  // Documenting the contract rather than wishing it away: runPool is a plain
  // Promise.all, so one throw abandons the queue and discards whatever the
  // other workers had collected. The live runner therefore wraps its own task
  // body and records a failure row instead of throwing. If this ever starts
  // swallowing, that wrapper becomes dead code and someone should know.
  const workers = [{ index: 1 }];
  await assert.rejects(
    () => runPool(workers, ["a", "b"], async (_worker, item) => {
      if (item === "a") throw new Error("launch blew up");
    }),
    /launch blew up/,
  );
});

test("runPool: more workers than items leaves the spare ones idle, not stuck", async () => {
  const workers = [{ index: 1 }, { index: 2 }, { index: 3 }];
  const seen = [];
  await runPool(workers, ["only"], async (_worker, item) => { seen.push(item); });
  assert.deepEqual(seen, ["only"]);
});

// ─── copyWorkspace ──────────────────────────────────────────────────────────

test("copyWorkspace: brings the fixtures, leaves the per-run leftovers", () => {
  const root = tmpDir();
  const src = path.join(root, "templates");
  const dest = path.join(root, "shard", "templates");

  write(path.join(src, ".env"), "STEPTIX_SERVER_URL=http://localhost:3100\n");
  write(path.join(src, "init", "steptix.config.json"), "{}");
  write(path.join(src, "init", "tests", "example.md"), "## Steps\n");
  write(path.join(src, "init", "skills", "flows", "enter_email.md"), "skill\n");
  // Leftovers a previous local run would have left behind.
  write(path.join(src, "init", "reports", "old-run.html"), "<html>");
  write(path.join(src, "init", ".steptix", "cdp-profiles", "chromium-default", "Local State"), "{}");
  write(path.join(src, "init", "tests", ".steptix-codebehind-cache", "x.candidate"), "x");
  write(path.join(src, "init", "tests", "example.steps.ts"), "export default {}");

  copyWorkspace(src, dest);

  assert.ok(fs.existsSync(path.join(dest, ".env")));
  assert.ok(fs.existsSync(path.join(dest, "init", "steptix.config.json")));
  assert.ok(fs.existsSync(path.join(dest, "init", "tests", "example.md")));
  assert.ok(fs.existsSync(path.join(dest, "init", "skills", "flows", "enter_email.md")));

  assert.equal(fs.existsSync(path.join(dest, "init", "reports")), false, "reports/");
  assert.equal(fs.existsSync(path.join(dest, "init", ".steptix")), false, ".steptix/");
  assert.equal(
    fs.existsSync(path.join(dest, "init", "tests", ".steptix-codebehind-cache")),
    false,
    ".steptix-codebehind-cache/",
  );
  // The sharpest of them: no compiled step file is tracked in this repo, so
  // one that exists is a leftover — and a shard that starts with it proves
  // nothing when it asserts that a compile wrote it.
  assert.equal(
    fs.existsSync(path.join(dest, "init", "tests", "example.steps.ts")),
    false,
    "*.steps.ts",
  );
});

test("copyWorkspace: replaces a previous shard's copy rather than merging into it", () => {
  const root = tmpDir();
  const src = path.join(root, "templates");
  const dest = path.join(root, "shard", "templates");
  write(path.join(src, ".env"), "STEPTIX_SERVER_URL=x\n");
  write(path.join(src, "keep.md"), "keep");

  copyWorkspace(src, dest);
  // What the last run wrote into its copy: a compiled file and a stale report.
  write(path.join(dest, "init", "tests", "leftover.steps.ts"), "stale");
  write(path.join(dest, "stale.md"), "stale");

  copyWorkspace(src, dest);

  assert.ok(fs.existsSync(path.join(dest, "keep.md")));
  assert.equal(fs.existsSync(path.join(dest, "stale.md")), false);
  assert.equal(fs.existsSync(path.join(dest, "init", "tests", "leftover.steps.ts")), false);
});

// ─── rebaseConfigPaths ──────────────────────────────────────────────────────

/**
 * A copied workspace shaped like templates/: `init/steptix.config.json` with the
 * real one's mix of in-tree paths and a toolsDir two levels up.
 */
function workspaceWithConfig(config, { at = ["init"] } = {}) {
  const root = tmpDir();
  const original = path.join(root, "templates");
  const copy = path.join(root, "shard", "templates");
  write(path.join(original, ...at, "steptix.config.json"), JSON.stringify(config, null, 2));
  write(path.join(original, ".env"), "STEPTIX_SERVER_URL=x\n");
  // The out-of-tree target has to actually exist for the assertions to be
  // about paths rather than about existence.
  fs.mkdirSync(path.join(root, "fixtures", "tools", "src"), { recursive: true });
  copyWorkspace(original, copy);
  return { root, original, copy };
}

test("rebaseConfigPaths: a path that climbs out of the workspace is pinned to the original", () => {
  // The real templates/init/steptix.config.json. In a copy this resolved to a
  // fixtures/ that was never copied, the server logged one `no tools
  // registered` WARN, and the run failed minutes later in an assertion about
  // compiled code.
  const { root, original, copy } = workspaceWithConfig({
    tests: { dir: "./tests", toolsDir: "../../fixtures/tools/src" },
    reports: { outputDir: "./reports" },
  });

  const notes = rebaseConfigPaths(copy, original);

  const written = JSON.parse(
    fs.readFileSync(path.join(copy, "init", "steptix.config.json"), "utf8"),
  );
  assert.equal(written.tests.toolsDir, path.join(root, "fixtures", "tools", "src"));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /toolsDir/);
});

test("rebaseConfigPaths: in-tree paths stay relative so they travel with the copy", () => {
  // Rewriting these would be the opposite of the point: every shard's reports
  // and tests would resolve back to the one original workspace.
  const { original, copy } = workspaceWithConfig({
    tests: { dir: "./tests", dataDir: "./data", skillsDir: "./skills" },
    reports: { outputDir: "./reports" },
  });

  rebaseConfigPaths(copy, original);

  const written = JSON.parse(
    fs.readFileSync(path.join(copy, "init", "steptix.config.json"), "utf8"),
  );
  assert.equal(written.tests.dir, "./tests");
  assert.equal(written.tests.dataDir, "./data");
  assert.equal(written.tests.skillsDir, "./skills");
  assert.equal(written.reports.outputDir, "./reports");
});

test("rebaseConfigPaths: a path that climbs but lands back inside is left alone", () => {
  // `init/../video-record/tests` is still in the copy, so it travels. Only
  // leaving the WORKSPACE matters, not leaving the project directory.
  const { original, copy } = workspaceWithConfig({
    tests: { dir: "../video-record/tests" },
  });

  rebaseConfigPaths(copy, original);

  const written = JSON.parse(
    fs.readFileSync(path.join(copy, "init", "steptix.config.json"), "utf8"),
  );
  assert.equal(written.tests.dir, "../video-record/tests");
});

test("rebaseConfigPaths: an absolute path is already pinned and is not touched", () => {
  const { original, copy } = workspaceWithConfig({
    tests: { toolsDir: path.resolve("/somewhere/else/tools") },
  });

  const notes = rebaseConfigPaths(copy, original);

  const written = JSON.parse(
    fs.readFileSync(path.join(copy, "init", "steptix.config.json"), "utf8"),
  );
  assert.equal(written.tests.toolsDir, path.resolve("/somewhere/else/tools"));
  assert.deepEqual(notes, []);
});

test("rebaseConfigPaths: an unknown key that climbs out is reported, not silently left", () => {
  // The next toolsDir. This runner cannot know what an unrecognised key means,
  // but the failure it causes surfaces far from the config, so it says so.
  const { original, copy } = workspaceWithConfig({
    tests: { dir: "./tests" },
    somethingNew: { assetsDir: "../../fixtures/assets" },
  });

  const notes = rebaseConfigPaths(copy, original);

  assert.equal(notes.length, 1);
  assert.match(notes[0], /^! /);
  assert.match(notes[0], /somethingNew\.assetsDir/);
});

test("rebaseConfigPaths: reaches every config in the workspace, not just the top one", () => {
  const root = tmpDir();
  const original = path.join(root, "templates");
  const copy = path.join(root, "shard", "templates");
  write(
    path.join(original, "init", "steptix.config.json"),
    JSON.stringify({ tests: { toolsDir: "../../fixtures/tools/src" } }),
  );
  write(
    path.join(original, "video-record", "steptix.config.json"),
    JSON.stringify({ tests: { toolsDir: "../../fixtures/tools/src" } }),
  );
  copyWorkspace(original, copy);

  const notes = rebaseConfigPaths(copy, original);

  assert.equal(notes.length, 2, `both configs rebased, got: ${notes.join(" | ")}`);
  for (const project of ["init", "video-record"]) {
    const written = JSON.parse(
      fs.readFileSync(path.join(copy, project, "steptix.config.json"), "utf8"),
    );
    assert.equal(written.tests.toolsDir, path.join(root, "fixtures", "tools", "src"));
  }
});

// ─── pointEnvAtServer ───────────────────────────────────────────────────────

test("pointEnvAtServer: rewrites STEPTIX_SERVER_URL in place, leaving the rest alone", () => {
  const dir = tmpDir();
  const env = path.join(dir, ".env");
  write(
    env,
    "AI_API_KEY=secret\nSTEPTIX_SERVER_URL=http://localhost:3100\nGITHUB_USERNAME=someone\n",
  );

  pointEnvAtServer(env, "http://localhost:3207");

  const text = fs.readFileSync(env, "utf8");
  assert.match(text, /^STEPTIX_SERVER_URL=http:\/\/localhost:3207$/m);
  assert.match(text, /^AI_API_KEY=secret$/m);
  assert.match(text, /^GITHUB_USERNAME=someone$/m);
  // Rewritten, not appended: a duplicate key does not reliably resolve the
  // same way in every .env parser, and "it depends" is not a property a test
  // harness should have.
  assert.equal(text.match(/^STEPTIX_SERVER_URL=/gm).length, 1);
});

test("pointEnvAtServer: appends STEPTIX_SERVER_URL when the file has none", () => {
  const dir = tmpDir();
  const env = path.join(dir, ".env");
  write(env, "AI_API_KEY=secret\n");

  pointEnvAtServer(env, "http://localhost:3207");

  const text = fs.readFileSync(env, "utf8");
  assert.match(text, /^AI_API_KEY=secret$/m);
  assert.match(text, /^STEPTIX_SERVER_URL=http:\/\/localhost:3207$/m);
});

test("pointEnvAtServer: a commented-out STEPTIX_SERVER_URL is not mistaken for the real one", () => {
  const dir = tmpDir();
  const env = path.join(dir, ".env");
  write(env, "# STEPTIX_SERVER_URL=http://localhost:9999\nAI_API_KEY=secret\n");

  pointEnvAtServer(env, "http://localhost:3207");

  const text = fs.readFileSync(env, "utf8");
  assert.match(text, /^# STEPTIX_SERVER_URL=http:\/\/localhost:9999$/m, "the comment survives");
  assert.match(text, /^STEPTIX_SERVER_URL=http:\/\/localhost:3207$/m, "a real line is added");
});

test("pointEnvAtServer: a missing .env is created holding only STEPTIX_SERVER_URL", () => {
  // A fresh clone has no templates/.env (it is gitignored). Skipping the file
  // would send the shard's extension at whatever STEPTIX_SERVER_URL the
  // walk-up found next — in practice another checkout's server, testing the
  // wrong `src/` while reporting green — so the shard gets a .env of its own.
  const dir = tmpDir();
  const env = path.join(dir, ".env");

  pointEnvAtServer(env, "http://localhost:3207");

  assert.equal(fs.readFileSync(env, "utf8"), "STEPTIX_SERVER_URL=http://localhost:3207\n");
});

// ─── liveAiProblem ─────────────────────────────────────────────────────────

/** A repo root with a templates/ dir and an empty machine file, all under tmp. */
function aiFixture({ templatesEnv, rootEnv, machineEnv, config } = {}) {
  const repoRoot = tmpDir();
  const templatesDir = path.join(repoRoot, "templates");
  fs.mkdirSync(templatesDir, { recursive: true });
  if (templatesEnv !== undefined) write(path.join(templatesDir, ".env"), templatesEnv);
  if (rootEnv !== undefined) write(path.join(repoRoot, ".env"), rootEnv);
  if (config !== undefined) write(path.join(repoRoot, "steptix.config.json"), JSON.stringify(config));
  const machineEnvPath = path.join(repoRoot, "machine", ".env");
  fs.mkdirSync(path.dirname(machineEnvPath), { recursive: true });
  if (machineEnv !== undefined) write(machineEnvPath, machineEnv);
  return { repoRoot, templatesDir, machineEnvPath, env: {} };
}

test("liveAiProblem: no key anywhere — names every place looked and the one line to add", () => {
  const f = aiFixture();
  const problem = liveAiProblem(f);
  assert.match(problem, /no AI_API_KEY was found/);
  assert.match(problem, /templates\/\.env/);
  assert.match(problem, /the environment/);
  assert.ok(problem.includes(f.machineEnvPath), "names the machine file");
  assert.match(problem, /AI_API_KEY=<your OpenAI API key>/);
});

test("liveAiProblem: a key in any one source passes — templates, environment, repo root or machine", () => {
  assert.equal(liveAiProblem(aiFixture({ templatesEnv: "AI_API_KEY=k\n" })), null);
  assert.equal(liveAiProblem({ ...aiFixture(), env: { AI_API_KEY: "k" } }), null);
  assert.equal(liveAiProblem(aiFixture({ rootEnv: "AI_API_KEY=k\n" })), null);
  assert.equal(liveAiProblem(aiFixture({ machineEnv: "AI_API_KEY=k\n" })), null);
});

test("liveAiProblem: a blank or commented-out key is no key", () => {
  const f = aiFixture({ templatesEnv: "AI_API_KEY=\n# AI_API_KEY=k\n" });
  assert.match(liveAiProblem(f), /no AI_API_KEY was found/);
});

test("liveAiProblem: a gateway-routed model with no AI_GATEWAY_URL anywhere is refused", () => {
  for (const model of ["aibroker/openai/x", "gateway/copilot/x"]) {
    const f = aiFixture({ machineEnv: `AI_API_KEY=k\nAI_MODEL=${model}\n` });
    const problem = liveAiProblem(f);
    assert.match(problem, new RegExp(`AI_MODEL=${model} routes through a gateway`));
    assert.match(problem, /AI_GATEWAY_URL/);
  }
});

test("liveAiProblem: a gateway-routed model passes once a URL is set in an env file or the config", () => {
  const key = "AI_API_KEY=k\nAI_MODEL=aibroker/openai/x\n";
  assert.equal(liveAiProblem(aiFixture({ machineEnv: `${key}AI_GATEWAY_URL=https://g.test\n` })), null);
  assert.equal(
    liveAiProblem(aiFixture({ machineEnv: key, config: { ai: { gatewayUrl: "https://g.test" } } })),
    null,
  );
});

test("liveAiProblem: a direct model needs no gateway URL", () => {
  assert.equal(liveAiProblem(aiFixture({ machineEnv: "AI_API_KEY=k\nAI_MODEL=openai/gpt-6-luna\n" })), null);
});

// ─── sharedServerStatsWarning ──────────────────────────────────────────────

test("sharedServerStatsWarning: says whose tag a shared server's lines carry, and how to start it tagged", () => {
  // A server the runner did not start is tagged by its OWN environment, so an
  // untagged one files every live-suite step as the user's own run.
  const text = sharedServerStatsWarning("http://localhost:3217");
  assert.match(text, /http:\/\/localhost:3217 was not started by this runner/);
  assert.match(text, /ITS OWN STEPTIX_STATS_SUITE/);
  assert.match(text, /steptix stats/);
  // Both shells, on the server's own port.
  assert.match(text, /\$env:STEPTIX_STATS_SUITE = 'live'; node dist\/index\.js serve -p 3217 --idle-timeout 60/);
  assert.match(text, /STEPTIX_STATS_SUITE=live node dist\/index\.js serve -p 3217 --idle-timeout 60/);
});

test("sharedServerStatsWarning: a URL with no readable port still names the command", () => {
  assert.match(sharedServerStatsWarning("not a url"), /serve -p <port>/);
  // The default port is implicit in the URL, so it cannot be read back either.
  assert.match(sharedServerStatsWarning("http://localhost"), /serve -p <port>/);
});
