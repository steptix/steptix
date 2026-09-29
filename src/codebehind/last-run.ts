import fs from 'node:fs/promises';
import path from 'node:path';
import type { StepStatus } from '../report/types.js';
import { logger } from '../utils/logger.js';
import { resolveCodeBehindCacheDir, type CodeBehindBinding } from './loader.js';

/**
 * The per-test last-run sidecar (stories/codebehind-compile.md, "The runtime
 * stops generating").
 *
 * Runs no longer write code-behind, so the only thing a run leaves behind for
 * the next compile is this: which steps ran as code, which ran under AI, and
 * which had an entry that broke. `steptix compile --only-stale` and the Steptix
 * gutter read it instead of re-running the test to find out.
 *
 * Gitignored (it lives in `.steptix-codebehind-cache/`, already ignored), and
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
  /**
   * The binding's `occurrence` — which of the identically-worded steps of one
   * frame instance this row is. Counted per frame instance, so it restarts at
   * 0 for every iteration of a looped body.
   *
   * Written so `priorFailure` can find the failure without counting rows. Its
   * rows are execution-ordered and a looped body writes one per ITERATION, so
   * the Nth row of an identity is iteration-major — while the compile that
   * reads it is offered one iteration only (an entry serves every row) and
   * asks for occurrence N. Positionally those two agree for iteration 1 and
   * nothing else: a body that failed on row 3 read back clean and regenerated
   * from scratch instead of going through the repair prompt.
   *
   * Optional so sidecars written before the field still read back, and the
   * reader falls back to the positional match for them.
   */
  occurrence?: number;
  status: StepStatus;
  /** True when the step ran its code-behind entry rather than calling the AI. */
  fromCodeBehind: boolean;
  /**
   * True when an entry threw — the step needs regenerating, which is the one
   * question this file answers for `--only-stale` and the repair prompt.
   *
   * Usually that means the step healed under AI. On a keyless run it means the
   * step failed instead, because there was no AI to heal it with
   * (stories/keyless-replay-and-gateway-env.md §Part B); see `healSkipped`.
   */
  stale: boolean;
  /** What the entry threw, when `stale`. */
  error?: string;
  /**
   * The entry threw and nothing healed it — a keyless run
   * (stories/keyless-replay-and-gateway-env.md §Part B).
   *
   * Only `staleRuns` reads it, and only to leave the streak alone: the count
   * below means "healed under AI N runs in a row", and a run with no AI healed
   * nothing. Everything else about the row is an ordinary stale row, on
   * purpose — the compile that repairs it does not care why nobody repaired it
   * sooner.
   */
  healSkipped?: boolean;
  /**
   * How many runs in a row this step has healed under AI
   * (stories/codebehind-selector-ambiguity.md §"A healed run stops reporting
   * as a clean pass"). `1` the first time, `2` the next, and so on; reset the
   * moment the step passes as code.
   *
   * The marker just shows it — "healed under AI (3 runs in a row)". There is
   * deliberately no threshold and no config knob: twelve reads worse than two
   * without anyone having to pick the N at which a warning "escalates".
   *
   * Carried forward by `writeLastRun` from the previous sidecar, so callers
   * building rows never set it. Absent on a non-stale row, and on every row of
   * a sidecar written before the field existed — where a stale row counts as
   * one run, which is what it is.
   */
  staleRuns?: number;
}

export interface LastRunSidecar {
  /** Absolute path of the test file this describes. */
  test: string;
  /** ISO 8601 timestamp of the run. */
  ranAt: string;
  steps: LastRunStep[];
}

/**
 * The stale row for a guard's MEMBER whose condition entry broke, when that
 * member is not the guard row's own line
 * (stories/codebehind-loops-and-conditions.md, "The run loops").
 *
 * A chain's guard row belongs to the member that HELD, and the model may pick
 * member C after member B's code threw. The row for C is not stale — C's entry
 * did nothing wrong — so B's failure gets a row of its own, keyed to B's
 * binding: that is the identity `--only-stale` and the repair look an entry up
 * by. Both sidecar writers build it here, so the two cannot drift.
 */
export function lastRunStaleMemberRow(args: {
  /** The member's absolute 0-based expanded index (`guard.staleMember`). */
  index: number;
  binding: CodeBehindBinding | undefined;
  /** The member's authored text, for a member with no binding. */
  fallbackSource: string;
  /** The guard visit's outcome — the member's condition is part of it. */
  status: StepStatus;
  error: string;
  /** Nothing healed it (a keyless run) — see {@link LastRunStep.healSkipped}. */
  healSkipped: boolean;
}): LastRunStep {
  const { binding } = args;
  return {
    index: args.index + 1,
    source: binding?.source ?? args.fallbackSource,
    ...(binding?.section !== undefined && { section: binding.section }),
    ...(binding?.file !== undefined && { file: binding.file }),
    ...(binding?.occurrence !== undefined && { occurrence: binding.occurrence }),
    status: args.status,
    fromCodeBehind: false,
    stale: true,
    error: args.error,
    ...(args.healSkipped && { healSkipped: true }),
  };
}

/** `tests/github.md` → `tests/.steptix-codebehind-cache/github.last-run.json`. */
export function lastRunPathFor(markdownFile: string): string {
  const resolved = path.resolve(markdownFile);
  const base = path.basename(resolved, path.extname(resolved));
  return path.join(resolveCodeBehindCacheDir(resolved), `${base}.last-run.json`);
}

/** Row identity across runs — the same shape the repair path matches on
 *  (`priorFailure`, live-compile.ts): section + source, narrowed by the
 *  entry's file where the row has one. Step *index* is deliberately not in
 *  the key: a step inserted above must not reset every streak below it.
 *
 *  Serialised as a JSON array rather than joined with a separator, so no
 *  step wording containing the separator can make two different rows collide. */
function rowKey(step: LastRunStep): string {
  const file = step.file === undefined
    ? ''
    : process.platform === 'win32'
      ? path.resolve(step.file).toLowerCase()
      : path.resolve(step.file);
  return JSON.stringify([step.section ?? '', step.source, file]);
}

/**
 * Carry each row's consecutive-stale count forward from the previous sidecar:
 * one more run for a step that is stale again, and gone for a step that is
 * not — which is the reset when it passes as code.
 *
 * Rows are matched by identity and then by occurrence, so a test with the same
 * step text twice keeps two independent streaks.
 *
 * A previous stale row with no `staleRuns` counts as one run: that is a
 * sidecar written before the field existed, and it recorded exactly one run's
 * healing.
 */
function carryStaleRuns(previous: LastRunStep[], steps: LastRunStep[]): LastRunStep[] {
  const before = new Map<string, LastRunStep[]>();
  for (const row of previous) {
    if (typeof row?.source !== 'string') continue;
    const key = rowKey(row);
    const bucket = before.get(key);
    if (bucket) bucket.push(row);
    else before.set(key, [row]);
  }
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const key = rowKey(step);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    if (!step.stale || step.healSkipped) {
      // Not healing this run — no streak. Deleted rather than written as 0 so
      // a clean sidecar stays as quiet as it was before the field existed.
      //
      // `healSkipped` lands here too: the row IS stale (the entry broke and
      // wants regenerating) but the run had no AI, so counting it would make
      // the marker say "healed under AI (3 runs in a row)" about a machine
      // that has never healed anything.
      const { staleRuns: _dropped, ...rest } = step;
      return rest;
    }
    const prior = before.get(key)?.[occurrence];
    const priorRuns = prior?.staleRuns ?? (prior?.stale ? 1 : 0);
    return { ...step, staleRuns: priorRuns + 1 };
  });
}

/** Write the sidecar. Never throws — a run must not fail over its own
 *  bookkeeping. */
export async function writeLastRun(
  markdownFile: string,
  steps: LastRunStep[],
): Promise<void> {
  const file = lastRunPathFor(markdownFile);
  // The consecutive-stale count is the one thing the sidecar remembers ACROSS
  // runs, so it is read back before the wholesale overwrite. `readLastRun`
  // never throws, and the carry-forward is guarded too — a sidecar someone
  // hand-edited into nonsense must cost a streak, never a run.
  let carried = steps;
  try {
    const previous = await readLastRun(markdownFile);
    carried = carryStaleRuns(previous?.steps ?? [], steps);
  } catch (err) {
    logger.debug(`Could not carry code-behind stale counts forward: ${String(err)}`);
  }
  const payload: LastRunSidecar = {
    test: path.resolve(markdownFile),
    ranAt: new Date().toISOString(),
    steps: carried,
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
    // Whatever the row was stale FOR is gone with the regeneration, including
    // the "nobody could heal this" note a keyless run left.
    delete step.healSkipped;
    // The streak ends with the regeneration, not with the next run that
    // proves it: leaving the count would make a repaired step still read
    // "healed under AI (3 runs in a row)".
    delete step.staleRuns;
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
