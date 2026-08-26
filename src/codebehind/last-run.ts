import fs from 'node:fs/promises';
import path from 'node:path';
import type { StepStatus } from '../report/types.js';
import { logger } from '../utils/logger.js';
import { resolveCodeBehindCacheDir } from './loader.js';

/**
 * The per-test last-run sidecar (stories/codebehind-compile.md, "The runtime
 * stops generating").
 *
 * Runs no longer write code-behind, so the only thing a run leaves behind for
 * the next compile is this: which steps ran as code, which ran under AI, and
 * which had an entry that broke. `aiui compile --only-stale` and the TestBench
 * gutter read it instead of re-running the test to find out.
 *
 * Gitignored (it lives in `.aiui-codebehind-cache/`, already ignored), and
 * strictly advisory: everything here is best-effort, and a missing or
 * unreadable sidecar means "nothing known", never an error.
 */

export interface LastRunStep {
  /** 1-based index of the expanded step. */
  index: number;
  /** The step's authored text — an entry's `source`. */
  source: string;
  /** Section scope, for a step defined in a `### Section` body. */
  section?: string;
  /**
   * The entry's target `.steps.ts` (the binding's `file`). Part of the row's
   * identity where present: a skill-body step and a test-frame step can share
   * `source` and an empty `section`, and only the file tells them apart.
   * Optional so sidecars written before the field still read back.
   */
  file?: string;
  status: StepStatus;
  /** True when the step ran its code-behind entry rather than calling the AI. */
  fromCodeBehind: boolean;
  /** True when an entry threw and the step healed under AI. */
  stale: boolean;
  /** What the entry threw, when `stale`. */
  error?: string;
}

export interface LastRunSidecar {
  /** Absolute path of the test file this describes. */
  test: string;
  /** ISO 8601 timestamp of the run. */
  ranAt: string;
  steps: LastRunStep[];
}

/** `tests/github.md` → `tests/.aiui-codebehind-cache/github.last-run.json`. */
export function lastRunPathFor(markdownFile: string): string {
  const resolved = path.resolve(markdownFile);
  const base = path.basename(resolved, path.extname(resolved));
  return path.join(resolveCodeBehindCacheDir(resolved), `${base}.last-run.json`);
}

/** Write the sidecar. Never throws — a run must not fail over its own
 *  bookkeeping. */
export async function writeLastRun(
  markdownFile: string,
  steps: LastRunStep[],
): Promise<void> {
  const file = lastRunPathFor(markdownFile);
  const payload: LastRunSidecar = {
    test: path.resolve(markdownFile),
    ranAt: new Date().toISOString(),
    steps,
  };
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  } catch (err) {
    logger.debug(`Could not write the code-behind last-run sidecar ${file}: ${String(err)}`);
  }
}

/**
 * Clear the stale flag on steps a green compile just regenerated.
 *
 * Without this the flag outlives the fix: the sidecar is written by *runs*,
 * and a compile writes files rather than running the test for real, so a
 * second `--only-stale` would regenerate the same steps again. Never throws,
 * and does nothing when there is no sidecar to amend.
 */
export async function clearStale(
  markdownFile: string,
  stepIndices: Iterable<number>,
): Promise<void> {
  const sidecar = await readLastRun(markdownFile);
  if (!sidecar) return;
  const fixed = new Set(stepIndices);
  let changed = false;
  for (const step of sidecar.steps) {
    if (!step.stale || !fixed.has(step.index)) continue;
    step.stale = false;
    delete step.error;
    changed = true;
  }
  if (!changed) return;
  try {
    await fs.writeFile(
      lastRunPathFor(markdownFile),
      `${JSON.stringify(sidecar, null, 2)}\n`,
      'utf-8',
    );
  } catch (err) {
    logger.debug(`Could not update the code-behind last-run sidecar: ${String(err)}`);
  }
}

/** Read the sidecar, or null when there is none / it is unreadable. */
export async function readLastRun(markdownFile: string): Promise<LastRunSidecar | null> {
  try {
    const raw = await fs.readFile(lastRunPathFor(markdownFile), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as LastRunSidecar).steps)
    ) {
      return null;
    }
    return parsed as LastRunSidecar;
  } catch {
    return null;
  }
}
