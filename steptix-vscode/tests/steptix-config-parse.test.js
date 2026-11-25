import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseProjectDirs,
  resolveDir,
  readProjectDirs,
  withDefaultDirs,
  DEFAULT_MACROS_DIR,
  DEFAULT_TOOLS_DIR,
} from "../src/extension/steptix-config-parse.js";

/** A project root for the tests that only need a path: `parseProjectDirs` and
 *  `resolveDir` never touch the disk. Native to the platform, so it is
 *  absolute on every OS. */
const PROJ = path.resolve(path.sep, "proj");

/** A fresh temp dir for a test that reads real files, removed when the test
 *  ends — pass or fail. The retries cover Windows, where Defender or the
 *  indexer can hold a just-written file for a moment. */
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steptix-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

test("parseProjectDirs: tests.macrosDir/toolsDir resolve to absolute paths against the config dir", () => {
  const dir = PROJ;
  const configPath = path.join(dir, "steptix.config.json");
  const text = JSON.stringify({
    tests: { macrosDir: "./macros", toolsDir: "./tools/src" },
  });

  const dirs = parseProjectDirs(text, configPath);
  assert.ok(dirs);
  assert.equal(dirs.configPath, configPath);
  assert.equal(dirs.macrosDir, path.resolve(dir, "./macros"));
  assert.equal(dirs.toolsDir, path.resolve(dir, "./tools/src"));
  assert.ok(path.isAbsolute(dirs.macrosDir));
  assert.ok(path.isAbsolute(dirs.toolsDir));
});

test("parseProjectDirs: no tests block → both null (the parse reports what is declared; readProjectDirs applies defaults)", () => {
  const configPath = path.join(PROJ, "steptix.config.json");
  const dirs = parseProjectDirs(JSON.stringify({ browser: { headed: true } }), configPath);
  assert.ok(dirs);
  assert.equal(dirs.macrosDir, null);
  assert.equal(dirs.toolsDir, null);
});

test("parseProjectDirs: tests.dataDir is surfaced raw (relative string) for env discovery", () => {
  const configPath = path.join(PROJ, "steptix.config.json");
  const dirs = parseProjectDirs(JSON.stringify({ tests: { dataDir: "./data" } }), configPath);
  assert.ok(dirs);
  // Raw string (not resolved) — the caller applies it relative to the root and
  // uses it for the source label.
  assert.equal(dirs.dataDir, "./data");
});

test("parseProjectDirs: tests.dir resolves to an absolute testsDir (Record New Test's folder), null when absent", () => {
  const dir = PROJ;
  const configPath = path.join(dir, "steptix.config.json");
  assert.equal(
    parseProjectDirs(JSON.stringify({ tests: { dir: "./fixtures/tests" } }), configPath).testsDir,
    path.resolve(dir, "./fixtures/tests"),
  );
  assert.equal(parseProjectDirs(JSON.stringify({ tests: { dataDir: "./data" } }), configPath).testsDir, null);
  assert.equal(parseProjectDirs(JSON.stringify({ tests: { dir: "" } }), configPath).testsDir, null);
});

test("parseProjectDirs: dataDir missing / empty / non-string → null (caller applies the `data` default)", () => {
  const configPath = path.join(PROJ, "steptix.config.json");
  assert.equal(parseProjectDirs(JSON.stringify({ tests: { dir: "./tests" } }), configPath).dataDir, null);
  assert.equal(parseProjectDirs(JSON.stringify({ tests: { dataDir: "" } }), configPath).dataDir, null);
  assert.equal(parseProjectDirs(JSON.stringify({ tests: { dataDir: 42 } }), configPath).dataDir, null);
});

test("parseProjectDirs: tests present but macrosDir/toolsDir missing or non-string → null", () => {
  const configPath = path.join(PROJ, "steptix.config.json");
  const dirs = parseProjectDirs(
    JSON.stringify({ tests: { dir: "./tests", macrosDir: 123, toolsDir: "" } }),
    configPath,
  );
  assert.ok(dirs);
  assert.equal(dirs.macrosDir, null);
  assert.equal(dirs.toolsDir, null);
});

test("parseProjectDirs: malformed JSON → null, no throw", () => {
  const configPath = path.join(PROJ, "steptix.config.json");
  let dirs;
  assert.doesNotThrow(() => {
    dirs = parseProjectDirs("{ this is not valid json ", configPath);
  });
  assert.equal(dirs, null);
});

test("resolveDir: empty / whitespace / non-string → null; non-empty string → absolute", () => {
  const base = PROJ;
  assert.equal(resolveDir("", base), null);
  assert.equal(resolveDir("   ", base), null);
  assert.equal(resolveDir(undefined, base), null);
  assert.equal(resolveDir(42, base), null);
  assert.equal(resolveDir("./macros", base), path.resolve(base, "./macros"));
});

test("readProjectDirs: reads a file and resolves dirs", (t) => {
  const dir = tmpDir(t);
  const configPath = path.join(dir, "steptix.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ tests: { macrosDir: "./macros", toolsDir: "./tools/src" } }),
  );

  const dirs = readProjectDirs(configPath);
  assert.ok(dirs);
  assert.equal(dirs.macrosDir, path.resolve(dir, "./macros"));
  assert.equal(dirs.toolsDir, path.resolve(dir, "./tools/src"));
});

test("readProjectDirs: missing file → null, no throw", (t) => {
  const configPath = path.join(tmpDir(t), "does-not-exist.json");
  let dirs;
  assert.doesNotThrow(() => {
    dirs = readProjectDirs(configPath);
  });
  assert.equal(dirs, null);
});

test("readProjectDirs: mtime cache returns the same object on a second call without a file change", (t) => {
  const dir = tmpDir(t);
  const configPath = path.join(dir, "steptix.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ tests: { macrosDir: "./macros", toolsDir: "./tools/src" } }),
  );

  const first = readProjectDirs(configPath);
  const second = readProjectDirs(configPath);
  assert.ok(first);
  // Same object identity — served from the mtime cache, not re-parsed.
  assert.equal(first, second);
});

test("readProjectDirs: a changed mtime re-reads the file", (t) => {
  const dir = tmpDir(t);
  const configPath = path.join(dir, "steptix.config.json");
  fs.writeFileSync(configPath, JSON.stringify({ tests: { macrosDir: "./macros" } }));
  const first = readProjectDirs(configPath);
  assert.equal(first?.macrosDir, path.resolve(dir, "./macros"));

  fs.writeFileSync(configPath, JSON.stringify({ tests: { macrosDir: "./other-macros" } }));
  // The cache is keyed on mtime alone, and two writes inside one mtime tick
  // (coarse on some filesystems) look unchanged to it. Moving the mtime
  // explicitly keeps this a test of the cache rather than of the clock.
  const later = new Date(fs.statSync(configPath).mtimeMs + 10_000);
  fs.utimesSync(configPath, later, later);

  const second = readProjectDirs(configPath);
  assert.notEqual(second, first, "a new object, not the cached one");
  assert.equal(second?.macrosDir, path.resolve(dir, "./other-macros"));
});

// ---------------------------------------------------------------------------
// Default folders (docs/specs/SPEC-macros.md §6): a project relying on the
// `./macros` / `./tools/src` defaults gets them in the editor too, as the CLI
// and MCP always did.
// ---------------------------------------------------------------------------

test("DEFAULT_MACROS_DIR / DEFAULT_TOOLS_DIR match the loader's defaults in src/config/defaults.ts", () => {
  const defaults = fs.readFileSync(
    path.join(import.meta.dirname, "..", "..", "src", "config", "defaults.ts"),
    "utf8",
  );
  assert.match(defaults, new RegExp(`macrosDir: '${DEFAULT_MACROS_DIR.replace(/[.*+?^${}()|[\]\/]/g, "\$&")}'`));
  assert.match(defaults, new RegExp(`toolsDir: '${DEFAULT_TOOLS_DIR.replace(/[.*+?^${}()|[\]\/]/g, "\$&")}'`));
});

test("readProjectDirs: undeclared macrosDir/toolsDir → the default folders beside the config, when they exist", (t) => {
  const dir = tmpDir(t);
  const configPath = path.join(dir, "steptix.config.json");
  fs.writeFileSync(configPath, JSON.stringify({ tests: { dir: "./tests" } }));
  fs.mkdirSync(path.join(dir, "macros"));
  fs.mkdirSync(path.join(dir, "tools", "src"), { recursive: true });

  const dirs = readProjectDirs(configPath);
  assert.equal(dirs?.macrosDir, path.resolve(dir, "macros"));
  assert.equal(dirs?.toolsDir, path.resolve(dir, "tools", "src"));
});

test("readProjectDirs: undeclared and no default folder → null, so callers say there is none", (t) => {
  const dir = tmpDir(t);
  const configPath = path.join(dir, "steptix.config.json");
  fs.writeFileSync(configPath, JSON.stringify({}));

  const dirs = readProjectDirs(configPath);
  assert.ok(dirs);
  assert.equal(dirs.macrosDir, null);
  assert.equal(dirs.toolsDir, null);
});

test("readProjectDirs: a macros folder created after the first read is found without a config edit", (t) => {
  const dir = tmpDir(t);
  const configPath = path.join(dir, "steptix.config.json");
  fs.writeFileSync(configPath, JSON.stringify({ tests: { dir: "./tests" } }));

  assert.equal(readProjectDirs(configPath)?.macrosDir, null);
  fs.mkdirSync(path.join(dir, "macros"));
  // Same config mtime, so the parse is served from the cache — the default
  // must still be looked for again.
  assert.equal(readProjectDirs(configPath)?.macrosDir, path.resolve(dir, "macros"));
});

test("readProjectDirs: a declared macrosDir is kept even when it is missing and ./macros exists", (t) => {
  const dir = tmpDir(t);
  const configPath = path.join(dir, "steptix.config.json");
  fs.writeFileSync(configPath, JSON.stringify({ tests: { macrosDir: "./shared/macros" } }));
  fs.mkdirSync(path.join(dir, "macros"));

  // A wrong declared path must fail loudly at the call ("Macro … not found at
  // <declared>/…"), not be swapped for a folder the config did not name.
  assert.equal(readProjectDirs(configPath)?.macrosDir, path.resolve(dir, "./shared/macros"));
});

test("readProjectDirs: an empty or non-string macrosDir counts as undeclared and takes the default", (t) => {
  const dir = tmpDir(t);
  const configPath = path.join(dir, "steptix.config.json");
  fs.writeFileSync(configPath, JSON.stringify({ tests: { macrosDir: "", toolsDir: 42 } }));
  fs.mkdirSync(path.join(dir, "macros"));
  fs.mkdirSync(path.join(dir, "tools", "src"), { recursive: true });

  const dirs = readProjectDirs(configPath);
  assert.equal(dirs?.macrosDir, path.resolve(dir, "macros"));
  assert.equal(dirs?.toolsDir, path.resolve(dir, "tools", "src"));
});

test("withDefaultDirs: returns the same object when both directories are declared", () => {
  const dirs = parseProjectDirs(
    JSON.stringify({ tests: { macrosDir: "./m", toolsDir: "./t" } }),
    path.join(PROJ, "steptix.config.json"),
  );
  assert.ok(dirs);
  assert.equal(withDefaultDirs(dirs), dirs);
});
