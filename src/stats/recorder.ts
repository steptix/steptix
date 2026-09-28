/**
 * Turns what a run already produced into scoreboard lines (§5, §7, §8).
 *
 * One recorder for every loop: the `StepResult` that `executeStep` returns
 * already carries each action's type, selector, error, match count, page and
 * timing, and each turn's model — everything an action line needs except who
 * ran it, which arrives as a {@link StatsContext}. So the conversion is a pure
 * function, {@link stepToLines}, and {@link recordStep} is that plus a
 * fire-and-forget append.
 *
 * Nothing here is awaited by a run and nothing here throws into one.
 */
import crypto from 'node:crypto';
import type { UserRootDeps } from '../env/user-root.js';
import {
  getAllAiInteractions,
  type AiInteraction,
  type StepResult,
  type StepStatus,
} from '../report/types.js';
import { redact } from '../utils/secrets.js';
import { actionSelector, classifyOutcome, classifySelectorForm } from './classify.js';
import { appendStatsLines, logStatsErrorOnce } from './store.js';
import type {
  StatsActionLine,
  StatsLine,
  StatsRunLine,
  StatsSource,
  StatsStepLine,
  StatsSuite,
} from './types.js';

/**
 * Who is running, set once per run by each loop (§7) and handed to every
 * `recordStep` of it.
 */
export interface StatsContext {
  /** From {@link newRunId}; ONE per run, data rows included (§8.1). */
  runId: string;
  /** The project root, absolute. */
  project: string;
  /** The test file relative to `project`, or `null` for ad hoc steps.
   *  Backslashes are written as `/`, so one test is one group on every
   *  platform. */
  test: string | null;
  /** The data row the steps belong to, when the run has rows. */
  row?: number | undefined;
  /**
   * `false` when the report writes no card for the step, so its lines carry
   * `card: false` and a reader prints no anchor: a watch group's branch steps
   * on the Sessions API. Set by the loop on the copy it hands those steps.
   */
  card?: false | undefined;
  suite: StatsSuite;
  /** The run's secret set — what `redact(…, maskValues)` hides in the report
   *  (`secretsFor` in the step executor). Take it fresh per step: captures
   *  grow it during a run. */
  maskValues?: string[] | undefined;
  /** `statsSettings(...).enabled`. False records nothing. */
  enabled: boolean;
  /** The user-root seam, for tests. */
  deps?: UserRootDeps | undefined;
}

/** What a step line needs that the `StepResult` does not carry. */
export interface StepLineMeta {
  /** The step AS AUTHORED — placeholders intact, never the interpolated
   *  instruction (§5.7). Masked here before it is written, and a skill
   *  body's `__skill<N>_` renames are taken back off its placeholders. */
  stepText: string;
  /** This execution's number within the run (`StatsStepFields.exec`), written
   *  on the step line and every one of its action lines. */
  exec: number;
  /** `rulesFingerprint(...)` under the run's prompt options; `null` for a line
   *  rebuilt from a report, which carries none (§10). Written only on the
   *  lines of a step that made a model call. */
  prompt?: string | null | undefined;
  /** `frameworkVersion()`. */
  fw?: string | undefined;
  /** When the step ended; defaults to now. Action lines use each action's own
   *  completion time when the result recorded one. */
  now?: Date | undefined;
}

/** What a run line summarises (§8.2). */
export interface StatsRunSummary {
  /** The run's status. */
  status: StepStatus | string;
  /** The user stopped the run. */
  aborted?: boolean | undefined;
  steps: number;
  /** Steps that passed first try — count them with {@link isFirstTry} so the
   *  run line and the step lines cannot disagree. */
  firstTry: number;
  failed: number;
  /** The run's totals from its token tracker. */
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  /** Absolute path of the report, or `null` when the run wrote none. */
  report: string | null;
  now?: Date | undefined;
}

/**
 * `r-YYYYMMDD-HHMMSS-xxxx`: the UTC start time and four random hex digits
 * (§8.1). `random` returns the suffix; it is a seam for tests.
 */
export function newRunId(
  now: Date = new Date(),
  random: () => string = () => crypto.randomBytes(2).toString('hex'),
): string {
  const at = Number.isNaN(now.getTime()) ? new Date() : now;
  const iso = at.toISOString(); // 2026-09-28T07:12:50.123Z
  return `r-${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}-${random()}`;
}

function normaliseTest(test: string | null): string | null {
  return test === null ? null : test.replaceAll('\\', '/');
}

/** An ISO timestamp from the result, normalised, or `fallback`. */
function isoOr(timestamp: string | undefined, fallback: Date): string {
  const time = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
  return (Number.isNaN(time) ? fallback : new Date(time)).toISOString();
}

/** Host of the page an action ran on, masked like every URL in the report —
 *  or `undefined` for a page without one (`about:blank`, `data:`, `file:`). */
function siteOf(pageUrl: string | undefined, masks: string[]): string | undefined {
  if (pageUrl === undefined) return undefined;
  try {
    const host = new URL(pageUrl).host;
    return host === '' ? undefined : redact(host, masks);
  } catch {
    return undefined;
  }
}

/**
 * Every model call the step made, once each: its turns' interactions (action
 * plans, clarifications, a readTable's structure question, a `[use ai]` call,
 * a guard's judge), its assertions' code generations, and the calls whose
 * results it discarded (a failed attempt's assertion code). By identity, so an
 * interaction a caller filed in two places is still one call.
 */
function interactionsOf(result: StepResult): AiInteraction[] {
  return [...new Set(getAllAiInteractions(result))];
}

/**
 * Whether a finished step gets lines at all (§7, "What counts as a step"):
 * one that asked the model something, or a code-behind replay.
 *
 * A step that made no model call is left out, whatever became of it — a
 * flow-control condition this run's values answered, a `[use ai]` line
 * refused before it was sent, a step that failed because the run has no AI
 * key or forbids AI. None of them says anything about how well the model does
 * a step, and counted they would move the first-try rate on steps the model
 * never saw. A code-behind replay is kept, tagged `source: 'code'`, because it
 * measures the compiled test (§5.6).
 */
export function recordable(result: StepResult): boolean {
  return result.fromCodeBehind === true || interactionsOf(result).length > 0;
}

/**
 * A skill body's placeholders as the author wrote them. `applySkillScope`
 * (src/skills/expander.ts) renames a skill-internal `{{name}}` to
 * `{{__skill<N>_name}}` and `[store as: name]` to `[store as:
 * __skill<N>_name]` — a spelling nobody wrote, and a different one per call,
 * which would split one authored step into as many groups as it has callers.
 * Only that prefix comes off, as often as nested calls applied it.
 */
function unscopedStepText(text: string): string {
  return text.replace(/(\{\{\s*|\[store\s+as:\s*)(?:__skill\d+_)+/gi, '$1');
}

/** A token count that can be summed: a finite, non-negative number or 0. */
function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Attempts the step made: the highest attempt any turn belongs to, and at
 *  least 2 when the result says it retried. A step with no turns (code, a
 *  tool, a `set`) made one. */
function attemptsOf(result: StepResult): number {
  let attempts = result.retried ? 2 : 1;
  for (const turn of result.turns) attempts = Math.max(attempts, turn.attemptNumber);
  return attempts;
}

/**
 * Passed on attempt 1 with no failed action (§5.2) — the headline number. A
 * step that passed only after a retry is a pass in the report and not a first
 * try here; so is one whose model recovered from a failed action inside its
 * first attempt.
 */
export function isFirstTry(result: StepResult): boolean {
  return (
    result.status === 'passed'
    && attemptsOf(result) === 1
    && !result.turns.some((turn) => turn.subActions.some((sub) => sub.error !== undefined))
  );
}

/**
 * One `StepResult` as scoreboard lines: an action line per sub-action per turn,
 * then one step line. Pure — no clock unless `meta.now` is absent, no I/O.
 *
 * Masking (§5.7): the selector, the step text and the site go through
 * `redact(…, ctx.maskValues)`, the report's own masking. The form is classified
 * from the RAW selector, since masking could change which rule fits and the
 * form says nothing a secret could. An action's `value` — the text it typed —
 * is never read.
 *
 * Every line carries `meta.exec`. The rules fingerprint goes only on the lines
 * of a step that made a model call: a code-behind replay was never shown the
 * rules, so a fingerprint on it would count it under rules it did not use.
 *
 * Whether a step gets lines at all is {@link recordable}'s call, made by the
 * caller; this is the conversion alone, for any result it is handed.
 */
export function stepToLines(result: StepResult, ctx: StatsContext, meta: StepLineMeta): StatsLine[] {
  const now = meta.now ?? new Date();
  const masks = ctx.maskValues ?? [];
  const source: StatsSource = result.fromCodeBehind ? 'code' : 'ai';
  const test = normaliseTest(ctx.test);
  // A data-row step knows its row even if a loop forgot to say so.
  const row = ctx.row ?? (result.loop?.kind === 'row' ? result.loop.index : undefined);
  const stepText = redact(unscopedStepText(meta.stepText), masks);
  const interactions = interactionsOf(result);
  // No call, no rules: the fingerprint says which rules the model was shown.
  const prompt = interactions.length > 0 ? meta.prompt : undefined;
  /** What every line of this step shares after its `v`, `kind` and `t`. */
  const shared = {
    run: ctx.runId,
    project: ctx.project,
    test,
    step: result.index,
    exec: meta.exec,
    ...(row !== undefined && { row }),
    ...(result.hookScope !== undefined && { hook: result.hookScope }),
    ...(result.hookIndex !== undefined && { hookIndex: result.hookIndex }),
    stepText,
  };
  /** The flags and tags every line of this step ends with. */
  const tail = {
    ...(prompt !== undefined && { prompt }),
    ...(meta.fw !== undefined && { fw: meta.fw }),
    ...(ctx.card === false && { card: false as const }),
    suite: ctx.suite,
    source,
  };

  const lines: StatsLine[] = [];
  const actions: StatsActionLine[] = [];
  for (const turn of result.turns) {
    // The action plan is a turn's first call; a clarification or a readTable
    // structure question after it goes to the same client.
    const model = turn.aiInteractions.find((interaction) => interaction.model !== undefined)?.model;
    for (const sub of turn.subActions) {
      const raw = actionSelector(sub.action);
      const selector = raw === undefined ? null : redact(raw, masks);
      const matchCount = sub.targeting?.matchCount;
      // The page the action ran on: `actionPageUrl` is set only when the
      // action moved the page, which leaves `pageUrl` naming the destination.
      const site = siteOf(sub.actionPageUrl ?? sub.pageUrl, masks);
      const line: StatsActionLine = {
        v: 1,
        kind: 'action',
        t: isoOr(sub.timestamp, now),
        ...shared,
        attempt: turn.attemptNumber,
        turn: turn.turnNumber,
        action: String(sub.action.action),
        selector,
        form: classifySelectorForm(raw),
        outcome: classifyOutcome(sub, result.surface),
        ...(matchCount !== undefined && { matchCount }),
        ms: sub.durationMs,
        ...(site !== undefined && { site }),
        ...(model !== undefined && { model }),
        ...tail,
      };
      actions.push(line);
      lines.push(line);
    }
  }

  // The step's site and model: its first action line's, or failing that its
  // first model call's — the first that has one, so a clarification with no
  // page of its own does not blank the page the plan was made on.
  const site =
    actions.find((line) => line.site !== undefined)?.site
    ?? firstDefined(interactions, (interaction) => siteOf(interaction.pageUrl, masks));
  const model =
    actions.find((line) => line.model !== undefined)?.model
    ?? firstDefined(interactions, (interaction) => interaction.model);

  // §7.1: every call's usage, summed. `calls` counts the calls whether or not
  // they carried usage; the token fields can only sum what was reported.
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCached: number | undefined;
  let estimated = false;
  for (const { usage } of interactions) {
    if (usage === undefined) continue;
    tokensIn += count(usage.inputTokens);
    tokensOut += count(usage.outputTokens);
    if (usage.cachedInputTokens !== undefined) {
      tokensCached = (tokensCached ?? 0) + count(usage.cachedInputTokens);
    }
    if (usage.estimated === true) estimated = true;
  }

  const step: StatsStepLine = {
    v: 1,
    kind: 'step',
    t: now.toISOString(),
    ...shared,
    status: result.status,
    ...(result.tolerated === true && { tolerated: true }),
    ...(result.interrupted === true && { interrupted: true }),
    attempts: attemptsOf(result),
    turns: result.turns.length,
    firstTry: isFirstTry(result),
    ms: result.durationMs,
    calls: interactions.length,
    tokensIn,
    tokensOut,
    ...(tokensCached !== undefined && { tokensCached }),
    ...(estimated && { tokensEstimated: true }),
    ...(site !== undefined && { site }),
    ...(model !== undefined && { model }),
    ...tail,
  };
  lines.push(step);
  return lines;
}

/** The first `pick(item)` that is not `undefined`. */
function firstDefined<T, R>(items: readonly T[], pick: (item: T) => R | undefined): R | undefined {
  for (const item of items) {
    const value = pick(item);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Record one executed step: {@link stepToLines}, then an unawaited append.
 * Does nothing when `ctx.enabled` is false, or for a step {@link recordable}
 * leaves out. Never throws — a malformed result costs its lines and one debug
 * line, never the step.
 */
export function recordStep(result: StepResult, ctx: StatsContext, meta: StepLineMeta): void {
  if (!ctx.enabled) return;
  let lines: StatsLine[];
  try {
    if (!recordable(result)) return;
    lines = stepToLines(result, ctx, meta);
  } catch (err) {
    logStatsErrorOnce('could not record a step', err);
    return;
  }
  appendStatsLines(lines, ctx.deps);
}

/** The run line (§8.2), written where the run's report is written. */
export function runToLine(ctx: StatsContext, summary: StatsRunSummary): StatsRunLine {
  return {
    v: 1,
    kind: 'run',
    t: (summary.now ?? new Date()).toISOString(),
    run: ctx.runId,
    project: ctx.project,
    test: normaliseTest(ctx.test),
    suite: ctx.suite,
    status: summary.status,
    ...(summary.aborted === true && { aborted: true }),
    steps: summary.steps,
    firstTry: summary.firstTry,
    failed: summary.failed,
    ...(summary.tokensIn !== undefined && { tokensIn: summary.tokensIn }),
    ...(summary.tokensOut !== undefined && { tokensOut: summary.tokensOut }),
    report: summary.report,
  };
}

/** Record the run line. Does nothing when `ctx.enabled` is false; never
 *  throws. */
export function recordRun(ctx: StatsContext, summary: StatsRunSummary): void {
  if (!ctx.enabled) return;
  let line: StatsRunLine;
  try {
    line = runToLine(ctx, summary);
  } catch (err) {
    logStatsErrorOnce('could not record a run', err);
    return;
  }
  appendStatsLines([line], ctx.deps);
}
