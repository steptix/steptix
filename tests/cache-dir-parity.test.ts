import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  cacheDirName as srcCacheDirName,
  envCacheSegment as srcEnvCacheSegment,
  sanitizeTestName as srcSanitizeTestName,
} from '../src/cache/step-cache.js';

// ── Cross-module parity (issues 012 + 028) ───────────────────────────────────
// Per the 028 decision, the canonical guard against drift between the two
// implementations of the cache-path helpers is a SHARED input→expected fixture
// asserted in BOTH packages. The src helpers (canonical, here) and the
// extension's mirror (testbench-native/src/extension/cache-paths.ts) must each
// reproduce the SAME frozen table. The extension suite reads the same
// tests/fixtures/cache-dir-parity.json file from its own test.

interface ParityRow {
  name: string;
  input: { env: string | null; testFilePath: string; projectRoot: string | null };
  expected: { envCacheSegment: string; cacheDirName: string };
}

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'cache-dir-parity.json',
);

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as { rows: ParityRow[] };
const rows = fixture.rows;

describe('cache-dir parity: src helpers match the frozen fixture', () => {
  it('the fixture is non-empty (guards against an accidentally emptied table)', () => {
    expect(rows.length).toBeGreaterThanOrEqual(8);
  });

  for (const row of rows) {
    it(`src reproduces fixture row: ${row.name}`, () => {
      expect(srcEnvCacheSegment(row.input.env ?? undefined)).toBe(
        row.expected.envCacheSegment,
      );
      expect(srcCacheDirName(row.input.testFilePath, row.input.projectRoot)).toBe(
        row.expected.cacheDirName,
      );
    });
  }

  it('same-basename rows in different dirs hash to DIFFERENT dir names', () => {
    // Sanity guard baked into the table: auth/checkout.md vs admin/checkout.md.
    const names = rows
      .filter((r) => path.basename(r.input.testFilePath, '.md') === 'checkout')
      .map((r) => r.expected.cacheDirName);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(2);
  });

  // cacheDirName MUST be a fixed point of sanitizeTestName: the server/CLI write
  // dir is path.join(base, sanitizeTestName(cacheDirName(...))), while the
  // extension's clear-cache joins the RAW cacheDirName(...). If those diverge for
  // any basename, "Clear Cache for This Test" silently misses the directory the
  // server wrote. Assert the property directly over every fixture row — the
  // empty-normalizing and cap-on-hyphen rows are the ones that used to break it.
  for (const row of rows) {
    it(`cacheDirName is idempotent under sanitizeTestName: ${row.name}`, () => {
      const dir = srcCacheDirName(row.input.testFilePath, row.input.projectRoot);
      expect(srcSanitizeTestName(dir)).toBe(dir);
    });
  }
});

// ── BONUS: direct cross-module assertion ─────────────────────────────────────
// cache-paths.ts has NO vscode dependency (only node builtins + crypto), so a
// direct import is feasible. We assert the extension mirror equals the src
// implementation for every fixture row, in the SAME vitest process. If this
// import ever fails to resolve, delete this block — the fixture half above plus
// the extension-suite half (testbench-native/tests/cache-dir-parity.test.js)
// still guard drift independently.
import {
  cacheDirName as extCacheDirName,
  envCacheSegment as extEnvCacheSegment,
  NO_ENV_NAMESPACE as extNoEnvNamespace,
} from '../testbench-native/src/extension/cache-paths.js';
import { NO_ENV_NAMESPACE as srcNoEnvNamespace } from '../src/cache/step-cache.js';

describe('cache-dir parity (BONUS): extension mirror === src for every fixture row', () => {
  it('the NO_ENV_NAMESPACE sentinel matches across modules', () => {
    expect(extNoEnvNamespace).toBe(srcNoEnvNamespace);
    expect(extNoEnvNamespace).toBe('default');
  });

  for (const row of rows) {
    it(`mirror matches src + fixture: ${row.name}`, () => {
      const segSrc = srcEnvCacheSegment(row.input.env ?? undefined);
      const segExt = extEnvCacheSegment(row.input.env);
      const dirSrc = srcCacheDirName(row.input.testFilePath, row.input.projectRoot);
      const dirExt = extCacheDirName(row.input.testFilePath, row.input.projectRoot);

      // Mirror equals canonical src.
      expect(segExt).toBe(segSrc);
      expect(dirExt).toBe(dirSrc);
      // And both equal the frozen fixture (transitively, but assert explicitly).
      expect(segExt).toBe(row.expected.envCacheSegment);
      expect(dirExt).toBe(row.expected.cacheDirName);
    });
  }
});
