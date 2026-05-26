import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseProjectDirs,
  resolveDir,
  readProjectDirs,
} from "../src/extension/aiui-config-parse.js";

/** Make a fresh temp dir for a test, returning its absolute path. */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aiui-cfg-"));
}

test("parseProjectDirs: tests.skillsDir/toolsDir resolve to absolute paths against the config dir", () => {
  const dir = tmpDir();
  const configPath = path.join(dir, "aiui.config.json");
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
  const configPath = path.join(tmpDir(), "aiui.config.json");
  const dirs = parseProjectDirs(JSON.stringify({ browser: { headed: true } }), configPath);
  assert.ok(dirs);
  assert.equal(dirs.skillsDir, null);
  assert.equal(dirs.toolsDir, null);
});

test("parseProjectDirs: cache.enabled true → cacheEnabled true", () => {
  const configPath = path.join(tmpDir(), "aiui.config.json");
  const dirs = parseProjectDirs(JSON.stringify({ cache: { enabled: true } }), configPath);
  assert.ok(dirs);
  assert.equal(dirs.cacheEnabled, true);
});

test("parseProjectDirs: cache.enabled false / absent / non-boolean → cacheEnabled false (opt-in default)", () => {
  const configPath = path.join(tmpDir(), "aiui.config.json");
  // Explicit false.
  assert.equal(
    parseProjectDirs(JSON.stringify({ cache: { enabled: false } }), configPath).cacheEnabled,
    false,
  );
  // No cache block at all.
  assert.equal(
    parseProjectDirs(JSON.stringify({ tests: { dir: "./tests" } }), configPath).cacheEnabled,
    false,
  );
  // Truthy-but-not-true value must not flip it on.
  assert.equal(
    parseProjectDirs(JSON.stringify({ cache: { enabled: "yes" } }), configPath).cacheEnabled,
    false,
  );
});

test("parseProjectDirs: tests present but skillsDir/toolsDir missing or non-string → null", () => {
  const configPath = path.join(tmpDir(), "aiui.config.json");
  const dirs = parseProjectDirs(
    JSON.stringify({ tests: { dir: "./tests", skillsDir: 123, toolsDir: "" } }),
    configPath,
  );
  assert.ok(dirs);
  assert.equal(dirs.skillsDir, null);
  assert.equal(dirs.toolsDir, null);
});

test("parseProjectDirs: malformed JSON → null, no throw", () => {
  const configPath = path.join(tmpDir(), "aiui.config.json");
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
  const configPath = path.join(dir, "aiui.config.json");
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
  const configPath = path.join(dir, "aiui.config.json");
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
