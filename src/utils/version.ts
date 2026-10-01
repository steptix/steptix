import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** The package root: `src/utils/` and `dist/utils/` both sit two levels under it. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let cached: string | undefined;

/**
 * This package's version, read once per process from `package.json`.
 *
 * One implementation on purpose: `steptix --version` and `GET /health`'s
 * `version` must agree, since the whole point of reporting it is telling the
 * user *which build* is answering. Two copies of the same `../../package.json`
 * relative walk would drift the moment the dist layout changes — and drift
 * silently, each falling back to its own placeholder.
 */
export function getPackageVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
      version?: string;
    };
    cached = pkg.version ?? 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}

/**
 * Which commit `dist/` was built from, and whether the working tree held
 * changes that commit does not. Stamped by `scripts/build-info.mjs` at the end
 * of `npm run build`.
 *
 * The version alone names a release, and many builds share one between
 * releases; this names the build. null means unknown — no stamp, no git when
 * it was built, or not built from a checkout — and is shown as such, never
 * guessed.
 */
export interface BuildInfo {
  /** Short (7-digit) commit, or null when unknown. */
  commit: string | null;
  /** True when the build held uncommitted changes; null when unknown. */
  modified: boolean | null;
}

let cachedBuild: BuildInfo | undefined;

/**
 * Read once per process, like the version. The stamp lives at
 * `<package root>/dist/build-info.json` whether this module runs from `dist/`
 * or from `src/` (under vitest, after `pretest` built it).
 */
export function getBuildInfo(): BuildInfo {
  if (cachedBuild !== undefined) return cachedBuild;
  try {
    cachedBuild = parseBuildInfo(JSON.parse(readFileSync(join(PACKAGE_ROOT, 'dist', 'build-info.json'), 'utf-8')));
  } catch {
    cachedBuild = { commit: null, modified: null }; // no stamp: unknown
  }
  return cachedBuild;
}

/** A stamp as read from disk. Anything malformed is unknown, and `modified`
 *  without a commit says nothing, so it is unknown too. */
export function parseBuildInfo(raw: unknown): BuildInfo {
  const stamp = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const commit = typeof stamp.commit === 'string' && /^[0-9a-f]{7}$/.test(stamp.commit) ? stamp.commit : null;
  return { commit, modified: commit !== null && typeof stamp.modified === 'boolean' ? stamp.modified : null };
}

/**
 * The version as a person reads it: `1.0.0-beta.1 (b700473)`, with `, modified`
 * after the commit when the build held uncommitted changes, and the version
 * alone when the commit is unknown. Fields are optional so a client can pass
 * a `/health` body from a server that predates them.
 */
export function describeVersion(build: {
  version?: string | undefined;
  commit?: string | null | undefined;
  modified?: boolean | null | undefined;
}): string {
  const version = build.version ?? 'unknown';
  if (!build.commit) return version;
  return `${version} (${build.commit}${build.modified ? ', modified' : ''})`;
}
