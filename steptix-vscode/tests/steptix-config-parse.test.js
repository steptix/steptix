import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseProjectDirs,
  resolveDir,
  readProjectDirs,
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

test("parseProjectDirs: tests.skillsDir/toolsDir resolve to absolute paths against the config dir", () => {
  const dir = PROJ;
  const configPath = path.join(dir, "steptix.config.json");
  const text = JSON.stringify({
    tests: { skillsDir: "./skills", toolsDir: "./tools/src" },
  });

  const dirs = parseProjectDirs(text, configPath);
  assert.ok(dirs);
  assert.equal(dirs.configPath, configPath);
  assert.equal(dirs.skillsDir, path.resolve(dir, "./skills"));
  assert.equal(dirs.toolsDir, path.resolve(dir, "./tools/src"));
  assert.ok(path.isAbsolute(dirs.skillsDir));
  assert.ok(path.isAbsolute(dirs.toolsDir));
});

test("parseProjectDirs: no tests block → both null", () => {
  const configPath = path.join(PROJ, "steptix.config.json");
  const dirs = parseProjectDirs(JSON.stringify({ browser: { headed: true } }), configPath);
  assert.ok(dirs);
  assert.equal(dirs.skillsDir, null);
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

test("parseProjectDirs: tests present but skillsDir/toolsDir missing or non-string → null", () => {
  const configPath = path.join(PROJ, "steptix.config.json");
  const dirs = parseProjectDirs(
    JSON.stringify({ tests: { dir: "./tests", skillsDir: 123, toolsDir: "" } }),
    configPath,
  );
  assert.ok(dirs);
  assert.equal(dirs.skillsDir, null);
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
  assert.equal(resolveDir("./skills", base), path.resolve(base, "./skills"));
});

test("readProjectDirs: reads a file and resolves dirs", (t) => {
  const dir = tmpDir(t);
  const configPath = path.join(dir, "steptix.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ tests: { skillsDir: "./skills", toolsDir: "./tools/src" } }),
  );

  const dirs = readProjectDirs(configPath);
  assert.ok(dirs);
  assert.equal(dirs.skillsDir, path.resolve(dir, "./skills"));
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
    JSON.stringify({ tests: { skillsDir: "./skills", toolsDir: "./tools/src" } }),
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
  fs.writeFileSync(configPath, JSON.stringify({ tests: { skillsDir: "./skills" } }));
  const first = readProjectDirs(configPath);
  assert.equal(first?.skillsDir, path.resolve(dir, "./skills"));

  fs.writeFileSync(configPath, JSON.stringify({ tests: { skillsDir: "./other-skills" } }));
  // The cache is keyed on mtime alone, and two writes inside one mtime tick
  // (coarse on some filesystems) look unchanged to it. Moving the mtime
  // explicitly keeps this a test of the cache rather than of the clock.
  const later = new Date(fs.statSync(configPath).mtimeMs + 10_000);
  fs.utimesSync(configPath, later, later);

  const second = readProjectDirs(configPath);
  assert.notEqual(second, first, "a new object, not the cached one");
  assert.equal(second?.skillsDir, path.resolve(dir, "./other-skills"));
});
