import { createHash } from 'node:crypto';
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
 * Mirrors `sanitizeTestName` in src/cache/step-cache.ts. The server now passes
 * `cacheDirName(testFilePath, projectRoot)` as `testName` to
 * `StepCache.initialize`, so the on-disk directory name is a path-derived
 * `<basename>-<hash>` (NOT the sanitized full path); `sanitizeTestName` still
 * backs `envCacheSegment` and is applied to that `testName` by `initialize`.
 * Any drift between this and the server function silently breaks "clear cache
 * for this test".
 *
 * `cacheDirName` and `envCacheSegment` below are ALSO mirrored verbatim from
 * src/cache/step-cache.ts (the env-namespaced, path-hash cache layout). Any
 * drift between this module and that one silently breaks "clear cache for
 * this test"; the cross-module parity fixture guards all three helpers.
 */
export function sanitizeTestName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

/** Sentinel env-namespace segment for tests that ran under no env. */
export const NO_ENV_NAMESPACE = 'default';

/** Sanitised, collision-free dir segment for an env (or the no-env sentinel). */
export function envCacheSegment(envName: string | null | undefined): string {
  return sanitizeTestName(envName?.trim() || NO_ENV_NAMESPACE);
}

/** Like `sanitizeTestName` but WITHOUT the .slice(0, 100) truncation. */
function normalizeForCache(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Stable, collision-free directory name for a test file: a readable basename
 * prefix plus a hash of the test's project-relative path (or absolute path
 * when no project root is known). Replaces the title-keyed name to kill
 * same-title collisions and the server's 100-char truncation.
 *
 * Idempotent under `sanitizeTestName` (see the canonical copy in
 * src/cache/step-cache.ts for the full rationale): the post-slice
 * `replace(/-+$/,'')` and the empty-base guard keep this a fixed point, so the
 * raw value the extension joins for clear-cache matches the value the server
 * writes after running it through `sanitizeTestName`.
 */
export function cacheDirName(testFilePath: string, projectRoot: string | null): string {
  const identity = projectRoot ? path.relative(projectRoot, testFilePath) : testFilePath;
  const base = normalizeForCache(path.basename(testFilePath, path.extname(testFilePath)))
    .slice(0, 60)
    .replace(/-+$/, '');
  const hash = createHash('sha256').update(normalizeForCache(identity)).digest('hex').slice(0, 12);
  return base ? `${base}-${hash}` : hash;
}

/**
 * Compute the on-disk cache directory for a given test file, or null if the
 * project root can't be located. The caller decides what to do with null
 * (typically: show a "no aiui.config.json above this file" status message).
 *
 * Layout: `<project-root>/.cache/<env-segment>/<basename>-<hash>/`. The
 * `.cache` literal stays — the extension assumes the default `cache.dir`.
 */
export function cacheDirForTest(testFilePath: string, envName: string | null | undefined): string | null {
  const projectRoot = resolveProjectRoot(testFilePath);
  if (!projectRoot) return null;
  return path.join(
    projectRoot,
    '.cache',
    envCacheSegment(envName),
    cacheDirName(testFilePath, projectRoot),
  );
}

/**
 * Every existing on-disk cache directory for a test file, ACROSS all env
 * segments. A single file can populate multiple env segments: an interactive
 * run uses the EnvSelector's active env, while a batch run keys off the test's
 * frontmatter env (`frontmatter.env ?? batchEnv` in test-controller.ts), so the
 * same file may have written `.cache/dev/<dir>/` AND `.cache/staging/<dir>/`.
 * "Clear Cache for This Test" must mean "clear", so it enumerates `.cache/*`/
 * and returns each `<basename>-<hash>` subdir that exists — not just the one
 * under the active env, which would silently miss the others (issue 012 gap).
 *
 * Returns [] when the project root can't be located or `.cache` doesn't exist.
 * The directory name is env-independent (path-hash derived), so one
 * `cacheDirName` is compared against every env segment.
 */
export function cacheDirsForTestAllEnvs(testFilePath: string): string[] {
  const projectRoot = resolveProjectRoot(testFilePath);
  if (!projectRoot) return [];
  const cacheRoot = path.join(projectRoot, '.cache');
  const dirName = cacheDirName(testFilePath, projectRoot);

  let envSegments: fs.Dirent[];
  try {
    envSegments = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return []; // no .cache yet, or unreadable
  }

  const hits: string[] = [];
  for (const seg of envSegments) {
    if (!seg.isDirectory()) continue;
    const candidate = path.join(cacheRoot, seg.name, dirName);
    if (fs.existsSync(candidate)) hits.push(candidate);
  }
  return hits;
}
