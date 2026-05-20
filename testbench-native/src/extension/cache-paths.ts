import * as fs from 'node:fs';
import * as path from 'node:path';

const PROJECT_MARKERS = ['aiui.config.json'];

/**
 * Walk up from `testFilePath` looking for a project marker. Returns the
 * absolute path of the first directory containing one, or null if the walk
 * reaches the filesystem root without finding one. Mirrors the server-side
 * `resolveProjectRoot` in src/server/project-root.ts so the extension finds
 * the same `<project-root>/.cache/` the server wrote.
 */
export function resolveProjectRoot(testFilePath: string): string | null {
  let dir = path.dirname(path.resolve(testFilePath));
  for (let i = 0; i < 50; i++) {
    for (const marker of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Mirrors `sanitizeTestName` in src/cache/step-cache.ts — the server passes
 * the test's absolute file path as `testName` to `StepCache.initialize`, so
 * the on-disk directory name is the sanitized full path. Any drift between
 * this and the server function silently breaks "clear cache for this test".
 */
export function sanitizeTestName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

/**
 * Compute the on-disk cache directory for a given test file, or null if the
 * project root can't be located. The caller decides what to do with null
 * (typically: show a "no aiui.config.json above this file" status message).
 */
export function cacheDirForTest(testFilePath: string): string | null {
  const projectRoot = resolveProjectRoot(testFilePath);
  if (!projectRoot) return null;
  return path.join(projectRoot, '.cache', sanitizeTestName(testFilePath));
}
