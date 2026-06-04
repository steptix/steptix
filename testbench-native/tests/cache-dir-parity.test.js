import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// cache-paths is authored in TypeScript (no .js sibling). Node strips the types
// on import; the literal `.ts` specifier is required because Node's ESM resolver
// does NOT rewrite a `.js` specifier to a `.ts` source. The module pulls in only
// node builtins + crypto (no vscode), so it loads cleanly under `node --test`.
import {
  cacheDirName,
  envCacheSegment,
  sanitizeTestName,
  NO_ENV_NAMESPACE,
} from "../src/extension/cache-paths.ts";

// ── Cross-module parity, extension half (issues 012 + 028) ───────────────────
// The cache-path helpers are MIRRORED verbatim from src/cache/step-cache.ts.
// Any drift between the mirror and the canonical implementation silently breaks
// "TestBench: Clear Cache for This Test" (the extension would look in a
// directory the server never wrote). The 028 decision pins a shared
// input→expected fixture asserted in BOTH packages; the root vitest suite
// (tests/cache-dir-parity.test.ts) asserts the SRC helpers against it, and this
// test asserts the EXTENSION's helpers against the SAME file.
//
// The other testbench-native node-test files import their subject straight from
// src/extension/*.js; cache-paths.ts has no vscode dependency (node builtins +
// crypto only), so the same direct-import convention works here under
// `node --test` (Node strips the TS types).

const here = path.dirname(fileURLToPath(import.meta.url));
// testbench-native/tests/ → repo-root tests/fixtures/cache-dir-parity.json
const fixturePath = path.resolve(here, "..", "..", "tests", "fixtures", "cache-dir-parity.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
const rows = fixture.rows;

test("parity fixture is present and non-empty", () => {
  assert.ok(Array.isArray(rows), "fixture.rows must be an array");
  assert.ok(rows.length >= 8, "fixture must carry the full frozen table");
});

test("NO_ENV_NAMESPACE sentinel matches the fixture's 'default' segment", () => {
  assert.equal(NO_ENV_NAMESPACE, "default");
});

test("extension cacheDirName + envCacheSegment reproduce the frozen fixture", () => {
  for (const row of rows) {
    const seg = envCacheSegment(row.input.env);
    const dir = cacheDirName(row.input.testFilePath, row.input.projectRoot);
    assert.equal(
      seg,
      row.expected.envCacheSegment,
      `envCacheSegment drift on row "${row.name}": got ${seg}, want ${row.expected.envCacheSegment}`,
    );
    assert.equal(
      dir,
      row.expected.cacheDirName,
      `cacheDirName drift on row "${row.name}": got ${dir}, want ${row.expected.cacheDirName}`,
    );
  }
});

test("same-basename rows in different dirs hash to DIFFERENT dir names", () => {
  const checkoutDirs = rows
    .filter((r) => path.basename(r.input.testFilePath, ".md") === "checkout")
    .map((r) => cacheDirName(r.input.testFilePath, r.input.projectRoot));
  assert.ok(checkoutDirs.length >= 2, "fixture must include >=2 same-basename rows");
  assert.equal(
    new Set(checkoutDirs).size,
    checkoutDirs.length,
    "same-basename files in different dirs must not collide",
  );
});

// cacheDirName MUST be a fixed point of sanitizeTestName: the server writes
// path.join(base, sanitizeTestName(cacheDirName(...))) while cacheDirForTest
// (the clear-cache path) joins the RAW cacheDirName(...). If they diverge for
// any basename, the extension clears a directory the server never wrote. Assert
// the property over every fixture row — the empty-normalizing and cap-on-hyphen
// rows are the ones that used to break it.
test("cacheDirName is idempotent under sanitizeTestName for every fixture row", () => {
  for (const row of rows) {
    const dir = cacheDirName(row.input.testFilePath, row.input.projectRoot);
    assert.equal(
      sanitizeTestName(dir),
      dir,
      `cacheDirName not idempotent on row "${row.name}": cacheDirName=${dir}, sanitizeTestName(cacheDirName)=${sanitizeTestName(dir)}`,
    );
  }
});
