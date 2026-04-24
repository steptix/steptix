import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AIAction, AIResponse } from '../ai/types.js';
import { interpolate } from '../parser/parameters.js';
import { logger } from '../utils/logger.js';

const SCHEMA_VERSION = 1;

interface CacheMeta {
  stepsHash: string;
  schemaVersion: number;
}

export interface CachedStepData {
  rawResponse: string;
  actions: AIAction[];
  reasoning: string;
  needs_reeval?: boolean;
}

interface CachedStepFile {
  rawResponse: string;
  actions: AIAction[];
  reasoning: string;
  needs_reeval?: boolean;
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
  async read(
    stepIndex: number,
    resolvedParams: Record<string, string>,
  ): Promise<CachedStepData | null> {
    const filePath = this.stepPath(stepIndex);

    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const cached: CachedStepFile = JSON.parse(raw);

      const actions = forwardInterpolate(cached.actions, resolvedParams);
      const rawResponse = interpolate(cached.rawResponse, resolvedParams);

      return {
        rawResponse,
        actions,
        reasoning: cached.reasoning,
        ...(cached.needs_reeval !== undefined && { needs_reeval: cached.needs_reeval }),
      };
    } catch {
      return null;
    }
  }

  /** Write an AI response to cache, reverse-interpolating parameter values to placeholders. */
  async write(
    stepIndex: number,
    rawResponse: string,
    parsed: AIResponse,
    resolvedParams: Record<string, string>,
  ): Promise<void> {
    const actions = reverseInterpolate(parsed.actions, resolvedParams);
    const templateRawResponse = reverseInterpolateString(rawResponse, resolvedParams);

    const data: CachedStepFile = {
      rawResponse: templateRawResponse,
      actions,
      reasoning: parsed.reasoning,
      ...(parsed.needs_reeval !== undefined && { needs_reeval: parsed.needs_reeval }),
    };

    try {
      await fs.writeFile(this.stepPath(stepIndex), JSON.stringify(data, null, 2));
    } catch (err) {
      logger.warn(`Failed to write cache for step ${stepIndex}: ${String(err)}`);
    }
  }

  /** Delete the cached response for a single step. */
  async invalidateStep(stepIndex: number): Promise<void> {
    try {
      await fs.unlink(this.stepPath(stepIndex));
    } catch {
      // Already gone — fine
    }
  }

  /** Read cached assertion JS code for a step, forward-interpolating parameter values. */
  async readAssertionCode(
    stepIndex: number,
    resolvedParams: Record<string, string>,
  ): Promise<string | null> {
    try {
      const raw = await fs.readFile(this.assertionPath(stepIndex), 'utf-8');
      const { code } = JSON.parse(raw) as { code: string };
      return interpolate(code, resolvedParams);
    } catch {
      return null;
    }
  }

  /** Cache assertion JS code for a step, reverse-interpolating parameter values. */
  async writeAssertionCode(
    stepIndex: number,
    code: string,
    resolvedParams: Record<string, string>,
  ): Promise<void> {
    try {
      const templateCode = reverseInterpolateString(code, resolvedParams);
      await fs.writeFile(this.assertionPath(stepIndex), JSON.stringify({ code: templateCode }, null, 2));
    } catch (err) {
      logger.warn(`Failed to write assertion code cache for step ${stepIndex}: ${String(err)}`);
    }
  }

  /** Delete cached assertion code for a step. */
  async invalidateAssertionCode(stepIndex: number): Promise<void> {
    try {
      await fs.unlink(this.assertionPath(stepIndex));
    } catch {
      // Already gone — fine
    }
  }

  private stepPath(stepIndex: number): string {
    return path.join(this.cacheDir, `step-${stepIndex}.json`);
  }

  private assertionPath(stepIndex: number): string {
    return path.join(this.cacheDir, `step-${stepIndex}-assertion.json`);
  }
}

/** SHA-256 hash of the raw steps array. */
export function computeStepsHash(steps: string[]): string {
  return createHash('sha256').update(JSON.stringify(steps)).digest('hex');
}

/** Sanitize a test name for use as a directory name. */
export function sanitizeTestName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

/**
 * Replace resolved parameter values with {{placeholder}} tokens in action `value` fields.
 * Sorts params by value length (longest first) to avoid partial matches.
 */
export function reverseInterpolate(
  actions: AIAction[],
  params: Record<string, string>,
): AIAction[] {
  const entries = Object.entries(params)
    .filter(([, v]) => v.length > 0)
    .sort((a, b) => b[1].length - a[1].length);

  if (entries.length === 0) return actions;

  return actions.map((action) => {
    if (!action.value) return action;

    let value = action.value;
    for (const [key, paramValue] of entries) {
      value = value.replaceAll(paramValue, `{{${key}}}`);
    }

    return value === action.value ? action : { ...action, value };
  });
}

/**
 * Replace resolved parameter values with {{placeholder}} tokens in a raw string.
 * Sorts params by value length (longest first) to avoid partial matches.
 */
function reverseInterpolateString(
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

/**
 * Replace {{placeholder}} tokens in action `value` fields with resolved parameter values.
 * Reuses the existing `interpolate()` function from the parser.
 */
export function forwardInterpolate(
  actions: AIAction[],
  params: Record<string, string>,
): AIAction[] {
  if (Object.keys(params).length === 0) return actions;

  return actions.map((action) => {
    if (!action.value) return action;

    const value = interpolate(action.value, params);
    return value === action.value ? action : { ...action, value };
  });
}
