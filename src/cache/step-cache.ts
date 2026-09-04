import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AIAction, AIResponse } from '../ai/types.js';
import { interpolate } from '../parser/parameters.js';
import { normaliseUploadPath } from '../browser/upload-paths.js';
import { forwardInterpolate } from '../runner/placeholder-substitution.js';
import { logger } from '../utils/logger.js';

/** Kept exported from here so nothing that imports it from the cache breaks.
 *  It lives in the runner now — the cache is being retired and the executor's
 *  act-time substitution outlives it
 *  (stories/placeholder-preserving-actions.md §Executor). */
export { forwardInterpolate };

// v4: per-step cache id changed from a bare source line to a frame-scoped key
// (`step-f1-17.json`) so skill-body steps and repeated invocations no longer
// collide with each other or with test-file steps on the same line number
// (issue 016). Bumping discards v3 line-keyed entries, which may be poisoned by
// the old collision.
const SCHEMA_VERSION = 4;

/**
 * Per-step cache identity. A bare source line (number) for inline test steps
 * and the CLI's ordinal path; a frame-scoped string (`f1-17`) for skill-body
 * steps, so repeated invocations of one skill don't share a cache file. Used
 * only for the on-disk filename — the step's display/line identity is separate.
 */
export type StepCacheKey = string | number;

interface CacheMeta {
  stepsHash: string;
  schemaVersion: number;
}

/** One AI turn's worth of cached data. */
export interface CachedStepData {
  rawResponse: string;
  actions: AIAction[];
  reasoning: string;
  needs_reeval?: boolean;
}

/** On-disk format: array of turns (schema v2). */
interface CachedStepFile {
  turns: CachedStepData[];
}

export class StepCache {
  private constructor(
    private readonly cacheDir: string,
    private readonly stepsHash: string,
  ) {}

  /**
   * Initialize the cache for a test. Validates existing cache against the
   * current steps hash — if stale, the entire test cache is deleted.
   */
  static async initialize(
    baseCacheDir: string,
    testName: string,
    steps: string[],
  ): Promise<StepCache> {
    const stepsHash = computeStepsHash(steps);
    const cacheDir = path.join(baseCacheDir, sanitizeTestName(testName));

    const metaPath = path.join(cacheDir, 'meta.json');

    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      const meta: CacheMeta = JSON.parse(raw);

      if (meta.stepsHash !== stepsHash || meta.schemaVersion !== SCHEMA_VERSION) {
        logger.info(`Cache stale for "${testName}" — clearing`);
        await fs.rm(cacheDir, { recursive: true, force: true });
      }
    } catch {
      // No existing cache or unreadable — start fresh
    }

    await fs.mkdir(cacheDir, { recursive: true });

    const meta: CacheMeta = { stepsHash, schemaVersion: SCHEMA_VERSION };
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

    return new StepCache(cacheDir, stepsHash);
  }

  /** Read a cached AI response for a step, forward-interpolating parameter values. */
  /** Read all cached turns for a step, forward-interpolating parameter values. */
  async read(
    stepIndex: StepCacheKey,
    resolvedParams: Record<string, string>,
  ): Promise<CachedStepData[] | null> {
    const filePath = this.stepPath(stepIndex);

    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const cached: CachedStepFile = JSON.parse(raw);

      if (!Array.isArray(cached.turns) || cached.turns.length === 0) return null;

      return cached.turns.map((turn) => ({
        rawResponse: interpolate(turn.rawResponse, resolvedParams),
        actions: forwardInterpolate(turn.actions, resolvedParams),
        reasoning: turn.reasoning,
        ...(turn.needs_reeval !== undefined && { needs_reeval: turn.needs_reeval }),
      }));
    } catch {
      return null;
    }
  }

  /** Write all turns for a step to cache, reverse-interpolating parameter values. */
  async write(
    stepIndex: StepCacheKey,
    turns: CachedStepData[],
    resolvedParams: Record<string, string>,
  ): Promise<void> {
    const data: CachedStepFile = {
      turns: turns.map((turn) => ({
        rawResponse: reverseInterpolateString(turn.rawResponse, resolvedParams),
        actions: reverseInterpolate(turn.actions, resolvedParams),
        reasoning: turn.reasoning,
        ...(turn.needs_reeval !== undefined && { needs_reeval: turn.needs_reeval }),
      })),
    };

    try {
      await fs.writeFile(this.stepPath(stepIndex), JSON.stringify(data, null, 2));
    } catch (err) {
      logger.warn(`Failed to write cache for step ${stepIndex}: ${String(err)}`);
    }
  }

  /** Delete the cached response for a single step. */
  async invalidateStep(stepIndex: StepCacheKey): Promise<void> {
    try {
      await fs.unlink(this.stepPath(stepIndex));
    } catch {
      // Already gone — fine
    }
  }

  /**
   * Read cached assertion JS code for a (step, assertIndex) pair, only when the
   * supplied fingerprint matches. Returns null on cache miss OR fingerprint mismatch.
   * Forward-interpolates parameter values into the returned code.
   */
  async readAssertion(
    stepIndex: StepCacheKey,
    assertIndex: number,
    fingerprint: string,
    resolvedParams: Record<string, string>,
  ): Promise<string | null> {
    try {
      const raw = await fs.readFile(this.assertsPath(stepIndex), 'utf-8');
      const map = JSON.parse(raw) as Record<string, { fingerprint: string; code: string }>;
      const entry = map[String(assertIndex)];
      if (!entry || entry.fingerprint !== fingerprint) return null;
      return interpolate(entry.code, resolvedParams);
    } catch {
      return null;
    }
  }

  /**
   * Cache assertion JS code for a (step, assertIndex) pair with its fingerprint.
   * Reverse-interpolates parameter values so the stored code is parameter-free.
   */
  async writeAssertion(
    stepIndex: StepCacheKey,
    assertIndex: number,
    fingerprint: string,
    code: string,
    resolvedParams: Record<string, string>,
  ): Promise<void> {
    try {
      const templateCode = reverseInterpolateString(code, resolvedParams);
      const filePath = this.assertsPath(stepIndex);
      let map: Record<string, { fingerprint: string; code: string }> = {};
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        map = JSON.parse(raw);
      } catch {
        // No existing file — start fresh
      }
      map[String(assertIndex)] = { fingerprint, code: templateCode };
      await fs.writeFile(filePath, JSON.stringify(map, null, 2));
    } catch (err) {
      logger.warn(`Failed to write assertion cache for step ${stepIndex} assert ${assertIndex}: ${String(err)}`);
    }
  }

  /** Delete a single assertion entry within a step. */
  async invalidateAssertion(stepIndex: StepCacheKey, assertIndex: number): Promise<void> {
    try {
      const filePath = this.assertsPath(stepIndex);
      const raw = await fs.readFile(filePath, 'utf-8');
      const map = JSON.parse(raw) as Record<string, { fingerprint: string; code: string }>;
      delete map[String(assertIndex)];
      if (Object.keys(map).length === 0) {
        await fs.unlink(filePath).catch(() => undefined);
      } else {
        await fs.writeFile(filePath, JSON.stringify(map, null, 2));
      }
    } catch {
      // Already gone — fine
    }
  }

  private stepPath(stepIndex: StepCacheKey): string {
    return path.join(this.cacheDir, `step-${stepIndex}.json`);
  }

  private assertsPath(stepIndex: StepCacheKey): string {
    return path.join(this.cacheDir, `step-${stepIndex}-asserts.json`);
  }
}

/**
 * Stable hash of an assertion's identity within a step. Includes assertIndex so
 * two asserts with the same condition/expected don't collide. Used as the cache
 * key for assertion JS code; changing condition or expected (or the assert's
 * position in the action list) invalidates the cached code automatically.
 */
/**
 * `expected` is `undefined` for predicate-mode assertions (no comparison
 * literal  both sides are already in `condition`). A sentinel keeps the
 * hash space distinct from any conceivable real `expected` value, so a
 * DOM assertion with `expected: ""` and a predicate assertion with the
 * same `condition` cache to different keys.
 */
const PREDICATE_EXPECTED_SENTINEL = '\u2205'; // U+2205 EMPTY SET  never appears in real expected literals.

export function fingerprintAssertion(
  condition: string,
  expected: string | undefined,
  assertIndex: number,
): string {
  const expectedKey = expected === undefined ? PREDICATE_EXPECTED_SENTINEL : expected;
  return createHash('sha256')
    .update(`${assertIndex} ${condition} ${expectedKey}`)
    .digest('hex')
    .slice(0, 16);
}

/** SHA-256 hash of the raw steps array. */
export function computeStepsHash(steps: string[]): string {
  return createHash('sha256').update(JSON.stringify(steps)).digest('hex');
}

/**
 * Build the on-disk cache id for a step. Inline test steps (empty/absent frame)
 * keep the bare source line (`17` → `step-17.json`); a skill-body step is
 * qualified by its invocation's frame (`f1` + line 17 → `f1-17` →
 * `step-f1-17.json`) so two invocations of one skill — or a skill step and a
 * test step that share a line number — never collide on one cache file
 * (issue 016). The result is stable across runs of an unchanged test+skills set
 * (the expander mints frame ids in a deterministic order), so cache hits hold.
 */
export function frameScopedStepKey(
  frameId: string | undefined,
  sourceLine: number,
): StepCacheKey {
  return frameId ? `${frameId}-${sourceLine}` : sourceLine;
}

/** Sanitize a test name for use as a directory name. */
export function sanitizeTestName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

/** Sentinel env-namespace segment for runs with no resolved env. */
export const NO_ENV_NAMESPACE = 'default';

/**
 * Sanitised, collision-free directory segment for an env name (issue 012).
 * Cache entries written under one env's segment are never read under another.
 * A run with no resolved env falls back to the `default` sentinel.
 */
export function envCacheSegment(envName?: string): string {
  return sanitizeTestName(envName?.trim() || NO_ENV_NAMESPACE);
}

/**
 * Like `sanitizeTestName` but WITHOUT the 100-char truncation. Used to build a
 * stable, path-derived cache directory name (issues 027/028) where the hash
 * must see the full normalized identity.
 */
function normalizeForCache(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Stable cache directory name derived from a test file's PATH rather than its
 * title (issues 027/028). Two tests sharing a title no longer collide, and the
 * server's 100-char title truncation no longer conflates distinct files.
 *
 * Shape: `<basename>-<hash>` where `basename` is the normalized file basename
 * (sans extension, capped at 60 chars for readability) and `hash` is the first
 * 12 hex chars of sha256 over the normalized path identity (relative to the
 * project root when known, else the raw path).
 *
 * Idempotent under `sanitizeTestName`: passing this value as the `testName`
 * argument to `StepCache.initialize` yields exactly `<base>/<cacheDirName>/`.
 * The post-slice `replace(/-+$/,'')` plus the empty-base guard are what make
 * that fixed-point property hold: without them a basename that normalizes to
 * empty (no [a-z0-9], e.g. `!!!.md`) would emit a LEADING hyphen, and a
 * basename whose normalized form has a separator exactly at the 60-char cap
 * would emit a DOUBLE hyphen at the join — both of which `sanitizeTestName`
 * strips, so the server's write dir would diverge from the extension's
 * clear-cache dir (the extension joins the raw `cacheDirName`).
 */
export function cacheDirName(testFilePath: string, projectRoot?: string | null): string {
  const identity = projectRoot ? path.relative(projectRoot, testFilePath) : testFilePath;
  const base = normalizeForCache(path.basename(testFilePath, path.extname(testFilePath)))
    .slice(0, 60)
    .replace(/-+$/, '');
  const hash = createHash('sha256').update(normalizeForCache(identity)).digest('hex').slice(0, 12);
  return base ? `${base}-${hash}` : hash;
}

/**
 * Every spelling of a parameter value that could appear inside an action.
 *
 * The raw value is the one a `value` field carries. A path field carries the
 * NORMALISED value instead, and that is not a nicety: the step is interpolated
 * before the model ever sees it, so a parameter written
 * `\attachments\march.pdf` reaches the model as text and comes back as
 * `attachments/march.pdf` in the action. Searching only for the raw spelling
 * would miss it, freeze the file name into the cache, and break replay on the
 * next machine (stories/upload-action.md §6).
 *
 * Longest-first across BOTH spellings of every parameter, not raw-first then
 * normalised: a short normalised form applied early can otherwise replace
 * inside another parameter's longer raw value.
 */
interface Substitution {
  key: string;
  value: string;
}

function substitutionCandidates(params: Record<string, string>): {
  /** Raw values only. A `type` action types what the parameter says. */
  forValue: Substitution[];
  /** Raw AND normalised, for the path fields only. */
  forPaths: Substitution[];
} {
  const forValue: Substitution[] = [];
  const forPaths: Substitution[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value.length === 0) continue;
    forValue.push({ key, value });
    forPaths.push({ key, value });
    const normalised = normaliseUploadPath(value);
    // Only a PATH-shaped normalisation earns a second candidate. Without
    // that test, a perfectly ordinary parameter like `route: "/logs"`
    // normalises to the bare token `logs` and starts matching text that has
    // nothing to do with it.
    if (normalised !== value && normalised.includes('/')) {
      forPaths.push({ key, value: normalised });
    }
  }
  const longestFirst = (a: Substitution, b: Substitution): number => b.value.length - a.value.length;
  return { forValue: forValue.sort(longestFirst), forPaths: forPaths.sort(longestFirst) };
}

/** Path fields on an action, in the order the executor reads them. */
function replacePathFields(
  action: AIAction,
  map: (text: string) => string,
): Partial<AIAction> | null {
  const patch: Partial<AIAction> = {};
  if (action.filePath !== undefined) {
    const next = map(action.filePath);
    if (next !== action.filePath) patch.filePath = next;
  }
  if (action.filePaths !== undefined) {
    const next = action.filePaths.map(map);
    if (next.some((p, i) => p !== action.filePaths![i])) patch.filePaths = next;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Replace resolved parameter values with {{placeholder}} tokens in an action's
 * `value` and upload-path fields. Sorts by value length (longest first) to
 * avoid partial matches.
 */
export function reverseInterpolate(
  actions: AIAction[],
  params: Record<string, string>,
): AIAction[] {
  const { forValue, forPaths } = substitutionCandidates(params);

  if (forValue.length === 0) return actions;

  const substituteWith = (entries: Substitution[]) => (text: string): string => {
    let out = text;
    for (const { key, value } of entries) {
      out = out.replaceAll(value, `{{${key}}}`);
    }
    return out;
  };
  const inValue = substituteWith(forValue);
  const inPath = substituteWith(forPaths);

  return actions.map((action) => {
    const pathPatch = replacePathFields(action, inPath);
    if (!action.value) return pathPatch ? { ...action, ...pathPatch } : action;

    const value = inValue(action.value);
    if (value === action.value) return pathPatch ? { ...action, ...pathPatch } : action;
    return { ...action, ...(pathPatch ?? {}), value };
  });
}

/**
 * Replace resolved parameter values with {{placeholder}} tokens in a raw string.
 * Sorts params by value length (longest first) to avoid partial matches.
 */
export function reverseInterpolateString(
  text: string,
  params: Record<string, string>,
): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v.length > 0)
    .sort((a, b) => b[1].length - a[1].length);

  if (entries.length === 0) return text;

  let result = text;
  for (const [key, paramValue] of entries) {
    result = result.replaceAll(paramValue, `{{${key}}}`);
  }
  return result;
}

// `forwardInterpolate` moved to src/runner/placeholder-substitution.ts and is
// re-exported at the top of this file.
