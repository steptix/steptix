/**
 * The run loops' side of the scoreboard (docs/specs/SPEC-scoreboard.md §7,
 * §8): who a run is, the one call that records an executed step, and the run
 * line.
 *
 * The recorder (src/stats/recorder.ts) turns a result into lines. This is what
 * the loops call: {@link openRunStats} once per run, a copy of what it returns
 * on the options of every step they run (`StepExecutorOptions.stats`), and
 * {@link recordRunEnd} where the run's report is written. Three things live
 * here rather than in the recorder, because they are facts about a LOOP, not
 * about a result:
 *
 *  - the hook scope a step runs in, and its place in the scope. The CLI stamps
 *    `hookScope` / `hookIndex` on a result after the executor has returned it
 *    — after the line was written;
 *  - the number the report will show, for the loops that file a result under
 *    another number than the one the executor was handed: the Sessions API
 *    hands it a source line and numbers the report by position, a watch
 *    group's rows arrive 0-based and are made 1-based, a Runner UI steer is
 *    filed under a slot past the test's last step;
 *  - the run line's counts, tallied as each step is recorded, so the run line
 *    and the step lines cannot disagree about a run.
 *
 * Nothing here is awaited on a step's path, and nothing here throws into one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertStatsSection } from '../config/loader.js';
import type { UserRootDeps } from '../env/user-root.js';
import type { StepResult } from '../report/types.js';
import { frameworkVersion, rulesFingerprint } from '../stats/fingerprint.js';
import {
  isFirstTry,
  newRunId,
  recordable,
  recordRun,
  recordStep,
  type StatsContext,
} from '../stats/recorder.js';
import { flushStatsWrites, logStatsErrorOnce, statsSettings } from '../stats/store.js';
import type { StatsSuite } from '../stats/types.js';
import { logger } from '../utils/logger.js';

/** What the run line counts (§8.2), kept as the run's steps are recorded. */
export interface RunTally {
  /**
   * Step lines the run wrote — hooks included, since each wrote one. Also the
   * run's execution counter: a step's `exec` is this count once it is added,
   * so the numbers run 1, 2, 3… across every copy of the context, rows and
   * loop passes included.
   */
  steps: number;
  /** Of those, the ones that passed first try (`isFirstTry`). */
  firstTry: number;
  /** Of those, the ones that failed — a tolerated failure included (the step
   *  did fail; only the run carried on), a step a Stop cut short not. */
  failed: number;
}

/**
 * A run's {@link StatsContext}, with what the loop knows beyond it.
 *
 * Loops pass a COPY on each step's options — `{ ...runStats, maskValues }` —
 * and a copy keeps the same `tally` object, so every step of the run counts
 * toward the one run line.
 */
export interface RunStats extends StatsContext {
  /** The hook scope this step runs in (`StepResult.hookScope`), set by a hook
   *  scope on its own copy: the loops stamp the result only after the step. */
  hook?: NonNullable<StepResult['hookScope']> | undefined;
  /** Which line of that scope it is, 1-based (`StepResult.hookIndex`) — a
   *  scope's lines share one step number, and this tells them apart. */
  hookIndex?: number | undefined;
  /**
   * The number the report will show for a result the loop renumbers after
   * the executor returns it, given the number the executor was handed. Absent
   * for every loop that files a result under the index it passed in.
   */
  reportIndex?: ((executorIndex: number) => number) | undefined;
  /**
   * The step as AUTHORED, for a step whose runner is handed something else as
   * its authored text: a hook line, whose `${…}` the parser substituted before
   * the run (hooks are not shown to the model as authored text), so the text
   * `executeStep` gets as `authoredInstruction` already holds the values. Set
   * by the loop on the copy it hands that one step; wins over the text the
   * runner reports.
   */
  stepText?: string | undefined;
  /** The run line's counts, shared by every copy of this context — and the
   *  run's execution counter (`RunTally.steps`). */
  tally?: RunTally | undefined;
}

export interface OpenRunStatsArgs {
  /** The root of the project the run uses — `null` when none resolved (no
   *  `aiui.config.json` above the test), which falls back to the test's
   *  folder, then to the working directory. */
  projectRoot: string | null | undefined;
  /** The test file, absolute or relative to the working directory; absent or
   *  `null` for ad hoc steps (an errand, a batch with no test file). */
  testFilePath?: string | null | undefined;
  /**
   * The project's switch (§6.4), from the config the run actually uses — per
   * project on the server, never the server's own. Pass
   * {@link statsEnabledIn}`(config)`: it fails closed on a value that is not
   * the JSON boolean. Only `true` or absent records; anything else, whatever
   * its type, does not.
   */
  projectEnabled?: boolean | undefined;
  /** A suite that overrides `AIUI_STATS_SUITE`: `compile` for a compile's
   *  runs (§5.6). */
  suite?: StatsSuite | undefined;
  /** An id to continue — a data-row run's rows share one (§8.1). */
  runId?: string | undefined;
  /** The data row, 1-based, when the run is one row of several. */
  row?: number | undefined;
  /** The user-root seam, for tests. */
  deps?: UserRootDeps | undefined;
}

/** The project root and the test relative to it, as §5.1 writes them. A test
 *  outside the root keeps its absolute path rather than a `../..` chain. */
function projectAndTest(
  projectRoot: string | null | undefined,
  testFilePath: string | null | undefined,
): { project: string; test: string | null } {
  const test = testFilePath ? path.resolve(testFilePath) : null;
  const project = path.resolve(projectRoot ?? (test !== null ? path.dirname(test) : process.cwd()));
  if (test === null) return { project, test: null };
  const relative = path.relative(project, test);
  const outside = relative === '' || relative.startsWith('..') || path.isAbsolute(relative);
  return { project, test: outside ? test : relative };
}

/**
 * The context one run records under: a fresh run id (or the one it
 * continues), who is running (`statsSettings`, with the project's own switch)
 * and an empty tally. Never throws — a context that cannot be built records
 * nothing rather than failing the run it describes.
 */
export function openRunStats(args: OpenRunStatsArgs): RunStats {
  try {
    // Fail closed: the store reads its switch as `!== false`, so a string
    // `"false"` that reached here untyped would keep recording. Only a real
    // `true` or an absent value is "on".
    const projectEnabled =
      args.projectEnabled === undefined ? undefined : args.projectEnabled === true;
    const settings = statsSettings({ projectEnabled, deps: args.deps });
    return {
      runId: args.runId ?? newRunId(),
      ...projectAndTest(args.projectRoot, args.testFilePath),
      ...(args.row !== undefined && { row: args.row }),
      suite: args.suite ?? settings.suite,
      enabled: settings.enabled,
      ...(args.deps !== undefined && { deps: args.deps }),
      tally: { steps: 0, firstTry: 0, failed: 0 },
    };
  } catch (err) {
    logStatsErrorOnce('could not open a run', err);
    return { runId: newRunId(), project: process.cwd(), test: null, suite: 'user', enabled: false };
  }
}

/**
 * A copy of `stats` for a step typed at a REPL prompt inside the run: the
 * run's identity and tally, but not the per-step facts a caller set for the
 * step the prompt interrupted — the ad hoc step is not a hook step, and the
 * report files it under its own number.
 */
export function adHocStats(stats: RunStats | undefined): RunStats | undefined {
  if (stats === undefined) return undefined;
  const copy: RunStats = { ...stats };
  delete copy.hook;
  delete copy.hookIndex;
  delete copy.reportIndex;
  delete copy.stepText;
  delete copy.card;
  return copy;
}

/**
 * A project's scoreboard switch (§6.4), failing closed: `true` only when the
 * config has no `stats` section, or one whose `enabled` is absent or exactly
 * `true`. Anything else — `false`, `"false"`, `0`, `"off"`, a `stats` that is
 * not an object — is off. The loader refuses those shapes at load
 * (`assertStatsSection`); this is what keeps one that arrives some other way
 * from being read as "record".
 */
export function statsEnabledIn(config: { readonly stats?: unknown } | null | undefined): boolean {
  const section: unknown = config?.stats;
  if (section === undefined) return true;
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return false;
  const enabled: unknown = (section as Record<string, unknown>)['enabled'];
  return enabled === undefined || enabled === true;
}

/** Config files whose `stats` section could not be read, warned about once. */
const unreadableSwitches = new Set<string>();

/**
 * The switch of the project a TEST belongs to (§6.4), for a runner that loaded
 * its config from somewhere else — `aiui run` and the Runner UI load the
 * working directory's `aiui.config.json`, while a test's lines are filed
 * under the project root its own path resolves to. Recording one project's
 * steps under another project's switch is how a project that said "never
 * keep my step text" gets it kept.
 *
 * Reads `<projectRoot>/aiui.config.json`'s `stats` section only — the rest of
 * that file is not this run's business, and a problem in it must not fail a
 * run that never read it. No root, or no config file at the root: the run's
 * own config decides. A file that does not parse, or a `stats` section of the
 * wrong type: OFF, with one warning naming the file — the switch cannot be
 * read, and a switch that cannot be read is not "record".
 */
export async function projectStatsSwitch(
  projectRoot: string | null | undefined,
  runConfig: { readonly stats?: unknown } | null | undefined,
): Promise<boolean> {
  if (!projectRoot) return statsEnabledIn(runConfig);
  const file = path.join(projectRoot, 'aiui.config.json');
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf-8');
  } catch {
    return statsEnabledIn(runConfig);
  }
  try {
    const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    const stats =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)['stats']
        : undefined;
    assertStatsSection(stats, file);
    return statsEnabledIn({ stats });
  } catch (err) {
    if (!unreadableSwitches.has(file)) {
      unreadableSwitches.add(file);
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Not recording this test's runs on the scoreboard — its project's switch cannot be read: ${message}`);
    }
    return false;
  }
}

/** How long a CLI waits for queued scoreboard lines before it exits anyway. */
export const STATS_FLUSH_TIMEOUT_MS = 2_000;

/**
 * Wait for the scoreboard's queued appends, but never longer than
 * `timeoutMs`. For a process about to exit (`aiui run`), whose unawaited
 * appends die with it: called in a `finally`, so a run that throws still
 * keeps its lines, and bounded, so an append stalled on a slow or locked disk
 * cannot hold the process open. Never rejects.
 */
export async function flushRunStats(timeoutMs: number = STATS_FLUSH_TIMEOUT_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([flushStatsWrites(), gaveUp]);
  } catch {
    /* the queue never rejects; nothing to add if it did */
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What {@link recordExecutedStep} needs that the result does not carry. */
export interface ExecutedStepMeta {
  /** The step AS AUTHORED — `{{placeholders}}` and `${…}` intact, never the
   *  interpolated instruction (§5.7). Masked before it is written. */
  stepText: string;
  /**
   * The step prompt's options, for a step answered from that prompt — the
   * `dismissalGuidance` the run handed `executeStep`, which the rules
   * fingerprint is taken under (§5.5). Absent for a step asked through a
   * prompt of its own (a `[use ai]` step, the computer surface): its lines then
   * carry no fingerprint rather than one for rules it was never shown.
   */
  rules?: { dismissalGuidance: boolean } | undefined;
  /** Values to mask beside the context's own, read when the step ended — a
   *  capture this step made is in them. */
  maskValues?: readonly string[] | undefined;
}

function mergeMasks(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): string[] | undefined {
  if (a === undefined || a.length === 0) return b === undefined ? undefined : [...b];
  if (b === undefined || b.length === 0) return [...a];
  return [...new Set([...a, ...b])];
}

/**
 * Record one executed step (§5.1, §5.2) and count it toward the run line.
 *
 * The ONE call a step's lines go through, from the one place each kind of step
 * finishes: the end of `executeStep`, of `executeComputerStep` and of
 * `runUseAiStep`. A caller that merges a nested result into an outer one must
 * not record the outer — the nested step already has its line.
 *
 * A step that made no model call and is not a code-behind replay writes
 * nothing and is not counted (`recordable`, §7 "What counts as a step"): the
 * run line's counts are the step lines' counts. A recorded step takes the
 * run's next execution number, shared by its step line and its action lines.
 *
 * Does nothing without a context, or with recording off. Never awaits and
 * never throws.
 */
export function recordExecutedStep(
  result: StepResult,
  stats: RunStats | undefined,
  meta: ExecutedStepMeta,
): void {
  if (stats === undefined || !stats.enabled) return;
  try {
    if (!recordable(result)) return;
    // Every copy of the context shares one tally, so this is the run's own
    // counter. A context built without one (never, from `openRunStats`) gets
    // one for itself rather than numbering every step 1.
    const tally = (stats.tally ??= { steps: 0, firstTry: 0, failed: 0 });
    tally.steps++;
    if (isFirstTry(result)) tally.firstTry++;
    if (result.status === 'failed' && result.interrupted !== true) tally.failed++;
    const exec = tally.steps;

    const index = stats.reportIndex ? stats.reportIndex(result.index) : result.index;
    const hookScope = result.hookScope ?? stats.hook;
    const hookIndex = result.hookIndex ?? (hookScope !== undefined ? stats.hookIndex : undefined);
    const asReported: StepResult =
      index === result.index && hookScope === result.hookScope && hookIndex === result.hookIndex
        ? result
        : {
            ...result,
            index,
            ...(hookScope !== undefined && { hookScope }),
            ...(hookIndex !== undefined && { hookIndex }),
          };
    const maskValues = mergeMasks(stats.maskValues, meta.maskValues);
    recordStep(
      asReported,
      { ...stats, ...(maskValues !== undefined && { maskValues }) },
      {
        stepText: stats.stepText ?? meta.stepText,
        exec,
        ...(meta.rules !== undefined && {
          prompt: rulesFingerprint({ dismissalGuidance: meta.rules.dismissalGuidance }),
        }),
        fw: frameworkVersion(),
      },
    );
  } catch (err) {
    logStatsErrorOnce('could not record a step', err);
  }
}

/** What the run line says beyond its counts (§8.2). */
export interface RunEnd {
  /** The run's status — the report's, when it wrote one. */
  status: string;
  /** The user stopped the run. */
  aborted?: boolean | undefined;
  /** The run's token totals: what the report's counts are read from. */
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  /** Absolute path of the report, or `null` when the run wrote none. */
  report: string | null;
}

/**
 * Write the run line, where the run's report is written (§8.2).
 *
 * A run that recorded no step AND wrote no report has nothing to link and
 * nothing to summarise, and writes nothing. Does nothing without a context or
 * with recording off; never throws.
 */
export function recordRunEnd(stats: RunStats | undefined, end: RunEnd): void {
  if (stats === undefined || !stats.enabled) return;
  const tally = stats.tally ?? { steps: 0, firstTry: 0, failed: 0 };
  if (tally.steps === 0 && end.report === null) return;
  recordRun(stats, {
    status: end.status,
    aborted: end.aborted,
    steps: tally.steps,
    firstTry: tally.firstTry,
    failed: tally.failed,
    tokensIn: end.tokensIn,
    tokensOut: end.tokensOut,
    report: end.report,
  });
}
