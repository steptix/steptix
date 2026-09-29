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

/** Make a fresh temp dir for a test, returning its absolute path. */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "steptix-cfg-"));
}

test("parseProjectDirs: tests.skillsDir/toolsDir resolve to absolute paths against the config dir", () => {
  const dir = tmpDir();
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
  const configPath = path.join(tmpDir(), "steptix.config.json");
  const dirs = parseProjectDirs(JSON.stringify({ browser: { headed: true } }), configPath);
  assert.ok(dirs);
  assert.equal(dirs.skillsDir, null);
  assert.equal(dirs.toolsDir, null);
});

test("parseProjectDirs: tests.dataDir is surfaced raw (relative string) for env discovery", () => {
  const configPath = path.join(tmpDir(), "steptix.config.json");
  const dirs = parseProjectDirs(JSON.stringify({ tests: { dataDir: "./data" } }), configPath);
  assert.ok(dirs);
  // Raw string (not resolved) — the caller applies it relative to the root and
  // uses it for the source label.
  assert.equal(dirs.dataDir, "./data");
});

test("parseProjectDirs: tests.dir resolves to an absolute testsDir (Record New Test's folder), null when absent", () => {
  const dir = tmpDir();
  const configPath = path.join(dir, "steptix.config.json");
  assert.equal(
    parseProjectDirs(JSON.stringify({ tests: { dir: "./fixtures/tests" } }), configPath).testsDir,
    path.resolve(dir, "./fixtures/tests"),
  );
  assert.equal(parseProjectDirs(JSON.stringify({ tests: { dataDir: "./data" } }), configPath).testsDir, null);
  assert.equal(parseProjectDirs(JSON.stringify({ tests: { dir: "" } }), configPath).testsDir, null);
});

test("parseProjectDirs: dataDir missing / empty / non-string → null (caller applies the `data` default)", () => {
  const configPath = path.join(tmpDir(), "steptix.config.json");
  assert.equal(parseProjectDirs(JSON.stringify({ tests: { dir: "./tests" } }), configPath).dataDir, null);
  assert.equal(parseProjectDirs(JSON.stringify({ tests: { dataDir: "" } }), configPath).dataDir, null);
  assert.equal(parseProjectDirs(JSON.stringify({ tests: { dataDir: 42 } }), configPath).dataDir, null);
});

test("parseProjectDirs: tests present but skillsDir/toolsDir missing or non-string → null", () => {
  const configPath = path.join(tmpDir(), "steptix.config.json");
  const dirs = parseProjectDirs(
    JSON.stringify({ tests: { dir: "./tests", skillsDir: 123, toolsDir: "" } }),
    configPath,
  );
  assert.ok(dirs);
  assert.equal(dirs.skillsDir, null);
  assert.equal(dirs.toolsDir, null);
});

test("parseProjectDirs: malformed JSON → null, no throw", () => {
  const configPath = path.join(tmpDir(), "steptix.config.json");
  let dirs;
  assert.doesNotThrow(() => {
    dirs = parseProjectDirs("{ this is not valid json ", configPath);
  });
  assert.equal(dirs, null);
});

test("resolveDir: empty / whitespace / non-string → null; non-empty string → absolute", () => {
  const base = tmpDir();
  assert.equal(resolveDir("", base), null);
  assert.equal(resolveDir("   ", base), null);
  assert.equal(resolveDir(undefined, base), null);
  assert.equal(resolveDir(42, base), null);
  assert.equal(resolveDir("./skills", base), path.resolve(base, "./skills"));
});

test("readProjectDirs: reads a file and resolves dirs", () => {
  const dir = tmpDir();
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

test("readProjectDirs: missing file → null, no throw", () => {
  const configPath = path.join(tmpDir(), "does-not-exist.json");
  let dirs;
  assert.doesNotThrow(() => {
    dirs = readProjectDirs(configPath);
  });
  assert.equal(dirs, null);
});

test("readProjectDirs: mtime cache returns the same object on a second call without a file change", () => {
  const dir = tmpDir();
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
