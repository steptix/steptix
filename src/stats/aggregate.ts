/**
 * The scoreboard's arithmetic (docs/specs/SPEC-scoreboard.md §9): what
 * `aiui stats` prints, as pure functions over the lines `readStatsLines`
 * returns. No clock and no disk: "now", and whether a report is still there
 * (§8.4), come in as arguments.
 *
 * Every view starts from {@link selectStatsLines}, which applies the window and
 * the filters once and joins what the lines keep apart: action lines carry no
 * report (§8.2), and a step line takes the site and model of its actions when
 * it does not carry its own. Then:
 *
 * - {@link summarizeStats}: actions grouped by form, site, model, prompt, test
 *   or outcome, plus the totals behind the Steps and Cost lines.
 * - {@link listFailures}: failed actions, newest first, each with its report.
 * - {@link listCostly}: the steps that used the most tokens.
 */
import { pathToFileURL } from 'node:url';
import { stepAnchor, type StepAnchorFields } from '../report/anchors.js';
import type {
  SelectorForm,
  StatsActionLine,
  StatsLine,
  StatsOutcome,
  StatsRunLine,
  StatsSource,
  StatsStepLine,
  StatsSuite,
} from './types.js';

export type StatsGroupBy = 'form' | 'site' | 'model' | 'prompt' | 'test' | 'outcome';

export const STATS_GROUP_BYS: readonly StatsGroupBy[] = ['form', 'site', 'model', 'prompt', 'test', 'outcome'];

/** The groupings a step can be counted under, which therefore also show
 *  tokens and calls a step. A step has one site, model, prompt and test, but
 *  many forms and outcomes. */
export const STEP_GROUP_BYS: ReadonlySet<StatsGroupBy> = new Set<StatsGroupBy>(['site', 'model', 'prompt', 'test']);

export const STATS_SUITES: readonly StatsSuite[] = ['user', 'live', 'bench', 'compile'];
export const STATS_SOURCES: readonly StatsSource[] = ['ai', 'code'];

/** The window when `--since` is not given. */
export const DEFAULT_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An outcome as a line carries it: one of §5.4's, or a word a newer framework
 * wrote, which still counts as a failure.
 */
export type LineOutcome = StatsOutcome | (string & {});

/** §5.4's failures in its table order, which also breaks ties between them. */
const FAILURE_ORDER: readonly string[] = [
  'conceded',
  'assert-failed',
  'unknown-action',
  'invalid-selector',
  'no-match',
  'blocked',
  'ambiguous',
  'timeout',
  'other',
];

/**
 * The execution a line belongs to (§5.1): one per run of a step, unique in its
 * run, shared by the step line and its action lines. Typed as always there,
 * but a line written before `exec` existed has none.
 */
function execOf(line: StatsActionLine | StatsStepLine): number | undefined {
  const exec: unknown = line.exec;
  return typeof exec === 'number' && Number.isInteger(exec) ? exec : undefined;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A number that can be summed: finite and positive, else 0. The store checks
 *  every line's types, but a reader should not be what a bad one breaks. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

// ── Selecting ────────────────────────────────────────────────────────────────

export interface StatsQuery {
  /** Start of the window, inclusive. */
  since: Date;
  /** End of the window, exclusive; absent for "up to now". */
  until?: Date | undefined;
  /** Which runs count (§5.6). */
  suites: readonly StatsSuite[];
  /** What drove the steps (§5.6). */
  sources: readonly StatsSource[];
  /** Part of the host, any case. */
  site?: string | undefined;
  /** The whole model id, any case. */
  model?: string | undefined;
  /** Part of the test's path, or a longer path that ends in it. */
  test?: string | undefined;
}

/** The last 30 days of the user's own runs, AI steps only (§5.6, §9). */
export function defaultStatsQuery(now: Date): StatsQuery {
  return {
    since: new Date(now.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS),
    suites: ['user'],
    sources: ['ai'],
  };
}

/** Where a step is counted when grouping or filtering by site or model. */
export interface StepAttribution {
  site: string | null;
  model: string | null;
}

/** Action lines and step lines, counted apart: what a person reads as "12
 *  actions and 5 steps". */
export interface LineCounts {
  actions: number;
  steps: number;
}

function noLines(): LineCounts {
  return { actions: 0, steps: 0 };
}

function countLine(counts: LineCounts, line: StatsActionLine | StatsStepLine): void {
  if (line.kind === 'action') counts.actions++;
  else counts.steps++;
}

export interface StatsSelection {
  query: StatsQuery;
  /** The action lines that match, in file order. */
  actions: StatsActionLine[];
  /** The step lines that match, in file order. */
  steps: StatsStepLine[];
  /** Every run line read, the last one per run, whatever the filters. A run
   *  line is written when the run ends, which can be after the window. */
  runs: ReadonlyMap<string, StatsRunLine>;
  /** The newest action or step line of every run read, in ms: how long a run
   *  with no run line has been quiet. */
  lastSeen: ReadonlyMap<string, number>;
  /** The site and model of every step line in the window: its own when the
   *  line carries them, else the ones most of its actions ran on and were
   *  chosen by. */
  attribution: ReadonlyMap<StatsStepLine, StepAttribution>;
  /** Steps with no card in their report (`card: false`), by {@link stepKey}. */
  noCard: ReadonlySet<string>;
  /** Action and step lines inside the window, before any filter. */
  inWindow: LineCounts;
  /** Lines inside the window that the filters left out: by the suite they
   *  belong to, else by their source, else by site, model or test. */
  leftOut: {
    suites: Partial<Record<string, LineCounts>>;
    sources: Partial<Record<string, LineCounts>>;
    filters: LineCounts;
  };
  /** The models named by the lines every filter but `--model` let through,
   *  most lines first: what `--model` could have matched. */
  models: Array<{ model: string; lines: number }>;
}

/**
 * What ties a step line to its action lines.
 *
 * With `exec` (§5.1): the run and the execution, which every line of one run
 * of one step shares and no other line of the run does — so each pass of a
 * loop body, and each line of a hook scope, is its own step.
 *
 * Without it (a line written before `exec` existed): the run, row, step
 * number, hook, the step's place in its hook scope, and step text. A hook's
 * step reuses the number of the step it wraps, and several steps of one hook
 * scope share that number, so the hook and its place are part of the key; the
 * text still separates lines written before `hookIndex` existed. Every pass of
 * a loop body is then one key.
 */
export function stepKey(line: StatsActionLine | StatsStepLine): string {
  const exec = execOf(line);
  if (exec !== undefined) return `${line.run}\u0000#${exec}`;
  return [
    line.run,
    line.row ?? '',
    line.step,
    line.hook ?? '',
    line.hookIndex ?? '',
    line.stepText ?? '',
  ].join('\u0000');
}

/** Values and how often each was seen, in the order first seen. A step has a
 *  handful of actions and almost always one site, so a list beats a map. */
type Tally = Array<[string, number]>;

function bump(tally: Tally, value: string | null): void {
  if (value === null) return;
  for (const entry of tally) {
    if (entry[0] === value) {
      entry[1]++;
      return;
    }
  }
  tally.push([value, 1]);
}

/** The value seen most often; a tie goes to the one seen first. */
function mostCommon(tally: Tally): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, n] of tally) {
    if (n > bestCount) {
      best = value;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Steps' sites and models from their action lines, by {@link stepKey}: the one
 * most of a step's actions carry, so a step counts in exactly one group and
 * the groups add up to the whole.
 */
function attributeFromActions(actions: readonly StatsActionLine[]): Map<string, StepAttribution> {
  const tallies = new Map<string, { sites: Tally; models: Tally }>();
  for (const line of actions) {
    const key = stepKey(line);
    let tally = tallies.get(key);
    if (tally === undefined) {
      tally = { sites: [], models: [] };
      tallies.set(key, tally);
    }
    bump(tally.sites, textOf(line.site));
    bump(tally.models, textOf(line.model));
  }
  const out = new Map<string, StepAttribution>();
  for (const [key, tally] of tallies) {
    out.set(key, { site: mostCommon(tally.sites), model: mostCommon(tally.models) });
  }
  return out;
}

function lower(value: string): string {
  return value.toLowerCase();
}

/** Forward slashes, any case, no leading `./`: how two spellings of one path
 *  are made comparable. */
function normalisePath(value: string): string {
  return lower(value.trim().replaceAll('\\', '/')).replace(/^(?:\.\/)+/, '');
}

/** `--test`: part of the test's own path (`recording`, `tests/recording.md`),
 *  or a longer path that ends in it (`templates/init/tests/recording.md`, or an
 *  absolute one pasted from a terminal). */
function testMatches(line: StatsActionLine | StatsStepLine, wanted: string): boolean {
  if (typeof line.test !== 'string') return false;
  const want = normalisePath(wanted);
  const test = normalisePath(line.test);
  if (test.includes(want)) return true;
  return `${normalisePath(line.project).replace(/\/+$/, '')}/${test}`.endsWith(want);
}

/**
 * A step line for a step that asked no model (§7): the writer no longer
 * records those, but older lines exist, and a `Set` or a condition that did
 * not hold would drag the first-try rate down. Code-behind replays make no
 * call either and are kept (§5.6).
 */
function askedNoModel(line: StatsActionLine | StatsStepLine): boolean {
  return line.kind === 'step' && line.source === 'ai' && count(line.calls) === 0 && count(line.turns) === 0;
}

const NOWHERE: StepAttribution = { site: null, model: null };

/**
 * The window and the filters, applied once. Run lines are kept whole (they are
 * what failures and costly steps link through), and each step's site and model
 * are settled — from its own line, or from ALL its action lines — before any
 * filter looks at them.
 */
export function selectStatsLines(lines: readonly StatsLine[], query: StatsQuery): StatsSelection {
  const since = query.since.getTime();
  const until = query.until?.getTime();
  const inWindowLines: Array<StatsActionLine | StatsStepLine> = [];
  const runs = new Map<string, StatsRunLine>();
  const lastSeen = new Map<string, number>();
  for (const line of lines) {
    if (line.kind === 'run') {
      runs.set(line.run, line);
      continue;
    }
    const t = Date.parse(line.t);
    if (Number.isNaN(t)) continue;
    const seen = lastSeen.get(line.run);
    if (seen === undefined || t > seen) lastSeen.set(line.run, t);
    if (t < since || (until !== undefined && t >= until) || askedNoModel(line)) continue;
    inWindowLines.push(line);
  }

  // A step a Stop cut short ended on the user's word, so it is not counted
  // (`ranToAnEnd`), and neither are its actions: the one the Stop cut off would
  // otherwise read as a failure of whatever selector it was using. Only lines
  // that carry `exec` can be matched to their step this exactly; older lines
  // keep counting, as they always did.
  const stopped = new Set<string>();
  for (const line of inWindowLines) {
    if (line.kind === 'step' && line.interrupted === true && execOf(line) !== undefined) stopped.add(stepKey(line));
  }
  if (stopped.size > 0) {
    for (let i = inWindowLines.length - 1; i >= 0; i--) {
      const line = inWindowLines[i]!;
      if (line.kind === 'action' && execOf(line) !== undefined && stopped.has(stepKey(line))) inWindowLines.splice(i, 1);
    }
  }

  // A step line's own site and model come first (§5.2): a step with no
  // actions (an assertion, a `[use ai]` call) has no other. Only a step line
  // without them — written before step lines carried them — needs its
  // actions tallied, so only its run's actions are keyed at all.
  const noCard = new Set<string>();
  const runsToTally = new Set<string>();
  for (const line of inWindowLines) {
    if (line.card === false) noCard.add(stepKey(line));
    if (line.kind === 'step' && (textOf(line.site) === null || textOf(line.model) === null)) runsToTally.add(line.run);
  }
  const fromActions = runsToTally.size === 0
    ? new Map<string, StepAttribution>()
    : attributeFromActions(
      inWindowLines.filter((line): line is StatsActionLine => line.kind === 'action' && runsToTally.has(line.run)),
    );
  const attribution = new Map<StatsStepLine, StepAttribution>();
  for (const line of inWindowLines) {
    if (line.kind !== 'step') continue;
    const site = textOf(line.site);
    const model = textOf(line.model);
    const theirs = site !== null && model !== null ? undefined : fromActions.get(stepKey(line));
    attribution.set(line, { site: site ?? theirs?.site ?? null, model: model ?? theirs?.model ?? null });
  }

  const site = query.site?.trim() || undefined;
  const model = query.model?.trim() || undefined;
  const test = query.test?.trim() || undefined;
  const leftOut: StatsSelection['leftOut'] = { suites: {}, sources: {}, filters: noLines() };
  // Only asked for when --model is: it is what that flag could have matched.
  const models = new Map<string, number>();
  const actions: StatsActionLine[] = [];
  const steps: StatsStepLine[] = [];
  const inWindow = noLines();

  for (const line of inWindowLines) {
    countLine(inWindow, line);
    if (!query.suites.includes(line.suite)) {
      countLine((leftOut.suites[line.suite] ??= noLines()), line);
      continue;
    }
    if (!query.sources.includes(line.source)) {
      countLine((leftOut.sources[line.source] ??= noLines()), line);
      continue;
    }
    if (site === undefined && model === undefined && test === undefined) {
      if (line.kind === 'action') actions.push(line);
      else steps.push(line);
      continue;
    }
    const where = line.kind === 'action'
      ? { site: textOf(line.site), model: textOf(line.model) }
      : attribution.get(line) ?? NOWHERE;
    const siteOk = site === undefined || (where.site !== null && lower(where.site).includes(lower(site)));
    const testOk = test === undefined || testMatches(line, test);
    const modelOk = model === undefined || (where.model !== null && lower(where.model) === lower(model));
    if (model !== undefined && siteOk && testOk && where.model !== null) {
      models.set(where.model, (models.get(where.model) ?? 0) + 1);
    }
    if (!(siteOk && testOk && modelOk)) {
      countLine(leftOut.filters, line);
      continue;
    }
    if (line.kind === 'action') actions.push(line);
    else steps.push(line);
  }

  return {
    query,
    actions,
    steps,
    runs,
    lastSeen,
    attribution,
    noCard,
    inWindow,
    leftOut,
    models: [...models].map(([id, n]) => ({ model: id, lines: n })).sort((a, b) => b.lines - a.lines),
  };
}

// ── Counting ─────────────────────────────────────────────────────────────────

export interface ActionStats {
  /** Every action line, every attempt. */
  actions: number;
  /** Action lines on the step's first attempt. */
  firstTryActions: number;
  /** Of those, the ones that worked. */
  firstTryOk: number;
  /** `firstTryOk / firstTryActions`; `null` with no first-attempt actions. */
  firstTryOkRate: number | null;
  /** Action lines by outcome, every attempt: the `--by outcome` view. */
  outcomes: Partial<Record<string, number>>;
  /**
   * The failure seen most often on a first attempt — among the same actions
   * `firstTryOkRate` is taken over, so the two explain each other — or `null`
   * when none failed there. A failure on a retry is still in `outcomes` and
   * in `--failures`.
   */
  topFailure: { outcome: LineOutcome; count: number } | null;
}

export interface StepStats {
  /** Steps that ran to an end: passed or failed. A skipped step never ran, and
   *  one a Stop cut short (`interrupted`) ended on the user's word, not the
   *  step's, so neither counts. */
  executed: number;
  /** Passed on attempt 1 with no failed action. */
  firstTry: number;
  /** Passed on a later attempt: the step was retried. */
  afterRetry: number;
  /** Passed on attempt 1, after an action failed and a later turn recovered. */
  afterFailedAction: number;
  failed: number;
  /** Model calls, every purpose and attempt. */
  calls: number;
  tokensIn: number;
  tokensOut: number;
  /** `(tokensIn + tokensOut) / executed`, or `null` with nothing executed. */
  tokensPerStep: number | null;
  /** `calls / executed`, or `null` with nothing executed. */
  callsPerStep: number | null;
  /** At least one step summed an estimate (§7.1). */
  estimated: boolean;
}

function isFailure(outcome: string): boolean {
  return outcome !== 'ok';
}

/** The commonest failure in `tally`; §5.4's order breaks a tie, and an
 *  outcome a newer framework added still counts. */
function commonestFailure(tally: ReadonlyMap<string, number>): ActionStats['topFailure'] {
  let top: ActionStats['topFailure'] = null;
  for (const outcome of FAILURE_ORDER) {
    const n = tally.get(outcome) ?? 0;
    if (n > 0 && (top === null || n > top.count)) top = { outcome, count: n };
  }
  for (const [outcome, n] of tally) {
    if (!isFailure(outcome) || FAILURE_ORDER.includes(outcome)) continue;
    if (top === null || n > top.count) top = { outcome, count: n };
  }
  return top;
}

class ActionTally {
  actions = 0;
  firstTryActions = 0;
  firstTryOk = 0;
  outcomes = new Map<string, number>();
  firstTryFailures = new Map<string, number>();

  add(line: StatsActionLine): void {
    this.actions++;
    this.outcomes.set(line.outcome, (this.outcomes.get(line.outcome) ?? 0) + 1);
    // First try is the step's first attempt (§5.1), whatever the turn.
    if (line.attempt !== 1) return;
    this.firstTryActions++;
    if (isFailure(line.outcome)) {
      this.firstTryFailures.set(line.outcome, (this.firstTryFailures.get(line.outcome) ?? 0) + 1);
    } else {
      this.firstTryOk++;
    }
  }

  finish(): ActionStats {
    const outcomes: Partial<Record<string, number>> = {};
    for (const [outcome, n] of this.outcomes) outcomes[outcome] = n;
    return {
      actions: this.actions,
      firstTryActions: this.firstTryActions,
      firstTryOk: this.firstTryOk,
      firstTryOkRate: this.firstTryActions === 0 ? null : this.firstTryOk / this.firstTryActions,
      outcomes,
      topFailure: commonestFailure(this.firstTryFailures),
    };
  }
}

/**
 * Whether a step counts in the Steps and Cost lines: it ran to an end, passed
 * or failed. A skipped step never ran (its `firstTry` is false only because it
 * did not pass), and one a Stop cut short ended on the user's word.
 */
export function ranToAnEnd(line: StatsStepLine): boolean {
  return line.interrupted !== true && (line.status === 'passed' || line.status === 'failed');
}

class StepTally {
  executed = 0;
  firstTry = 0;
  afterRetry = 0;
  afterFailedAction = 0;
  failed = 0;
  calls = 0;
  tokensIn = 0;
  tokensOut = 0;
  estimated = false;

  add(line: StatsStepLine): void {
    if (!ranToAnEnd(line)) return;
    if (line.status === 'passed') {
      if (line.firstTry === true) this.firstTry++;
      else if (count(line.attempts) > 1) this.afterRetry++;
      else this.afterFailedAction++;
    } else {
      this.failed++;
    }
    this.executed++;
    this.calls += count(line.calls);
    this.tokensIn += count(line.tokensIn);
    this.tokensOut += count(line.tokensOut);
    if (line.tokensEstimated === true) this.estimated = true;
  }

  finish(): StepStats {
    const n = this.executed;
    return {
      executed: n,
      firstTry: this.firstTry,
      afterRetry: this.afterRetry,
      afterFailedAction: this.afterFailedAction,
      failed: this.failed,
      calls: this.calls,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      tokensPerStep: n === 0 ? null : (this.tokensIn + this.tokensOut) / n,
      callsPerStep: n === 0 ? null : this.calls / n,
      estimated: this.estimated,
    };
  }
}

/**
 * Whole percentages of `counts` that add up to exactly 100 (or all 0 when
 * there is nothing to share): each share rounded down, then the points still
 * missing handed to the largest remainders — the larger count first on a tie,
 * then the earlier. So three equal thirds read 34, 33, 33, never 33, 33, 33.
 */
export function wholePercents(counts: readonly number[]): number[] {
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (!(total > 0)) return counts.map(() => 0);
  const exact = counts.map((n) => (n * 100) / total);
  const shares = exact.map((share) => Math.floor(share));
  let missing = 100 - shares.reduce((sum, n) => sum + n, 0);
  const order = counts
    .map((_, i) => i)
    .sort((a, b) => exact[b]! - shares[b]! - (exact[a]! - shares[a]!) || counts[b]! - counts[a]! || a - b);
  for (const i of order) {
    if (missing <= 0) break;
    shares[i]!++;
    missing--;
  }
  return shares;
}

// ── Summary ──────────────────────────────────────────────────────────────────

/**
 * Why a `--by prompt` group has no fingerprint (§5.5): lines imported from a
 * report, which carries none (`prompt: null`, §10), or steps asked through a
 * prompt of their own — a `[use ai]` step, the computer surface — whose lines
 * carry no `prompt` at all, because the step prompt's rules were never shown.
 */
export type Keyless = 'imported' | 'not-step-prompt';

export interface StatsGroup {
  /** The form, site, model, fingerprint, test or outcome; `null` for lines
   *  that have none (no selector, no site, no fingerprint, an ad hoc step). */
  key: string | null;
  /** For `--by prompt`, why `key` is `null`. */
  keyless?: Keyless;
  /** The group's oldest and newest line, ISO. */
  firstSeen: string;
  lastSeen: string;
  actions: ActionStats;
  /** For the step groupings ({@link STEP_GROUP_BYS}) only. */
  steps?: StepStats;
}

export interface StatsSummary {
  by: StatsGroupBy;
  groups: StatsGroup[];
  /** Every matching action. */
  actions: ActionStats;
  /** Every matching step: the Steps and Cost lines. */
  steps: StepStats;
}

interface GroupKey {
  key: string | null;
  keyless?: Keyless;
}

function promptKey(line: StatsActionLine | StatsStepLine): GroupKey {
  if (typeof line.prompt === 'string' && line.prompt !== '') return { key: line.prompt };
  return { key: null, keyless: line.prompt === null || line.imported === true ? 'imported' : 'not-step-prompt' };
}

function actionGroupKey(by: StatsGroupBy, line: StatsActionLine): GroupKey {
  switch (by) {
    case 'form': return { key: line.form ?? null };
    case 'site': return { key: textOf(line.site) };
    case 'model': return { key: textOf(line.model) };
    case 'prompt': return promptKey(line);
    case 'test': return { key: line.test ?? null };
    case 'outcome': return { key: line.outcome };
  }
}

function stepGroupKey(by: StatsGroupBy, line: StatsStepLine, where: StepAttribution | undefined): GroupKey {
  switch (by) {
    case 'site': return { key: where?.site ?? null };
    case 'model': return { key: where?.model ?? null };
    case 'prompt': return promptKey(line);
    default: return { key: line.test ?? null };
  }
}

interface GroupAcc {
  key: string | null;
  keyless: Keyless | undefined;
  first: number;
  last: number;
  actions: ActionTally;
  steps: StepTally | undefined;
}

/** Fingerprinted rules versions first, then imported lines, then steps that
 *  never saw the step prompt. */
function promptRank(acc: GroupAcc): number {
  return acc.key !== null ? 0 : acc.keyless === 'imported' ? 1 : 2;
}

/**
 * The matching lines grouped by `by`, each group with its actions, first-try
 * ok rate and commonest first-try failure; the step groupings also sum their
 * steps.
 *
 * Order: by rules version, oldest first, for `prompt` (it is a timeline, and
 * "did the change help" reads top to bottom), with the lines that have no
 * fingerprint last — imported ones, then the steps that never saw the step
 * prompt. Otherwise most actions first.
 */
export function summarizeStats(selection: StatsSelection, by: StatsGroupBy): StatsSummary {
  const stepGrouping = STEP_GROUP_BYS.has(by);
  const groups = new Map<string, GroupAcc>();
  const group = ({ key, keyless }: GroupKey, t: string): GroupAcc => {
    // A NUL cannot start a fingerprint, host, model id or path.
    const id = key ?? `\u0000${keyless ?? ''}`;
    let acc = groups.get(id);
    if (acc === undefined) {
      acc = { key, keyless, first: Infinity, last: -Infinity, actions: new ActionTally(), steps: stepGrouping ? new StepTally() : undefined };
      groups.set(id, acc);
    }
    const ms = Date.parse(t);
    if (ms < acc.first) acc.first = ms;
    if (ms > acc.last) acc.last = ms;
    return acc;
  };

  const allActions = new ActionTally();
  for (const line of selection.actions) {
    allActions.add(line);
    group(actionGroupKey(by, line), line.t).actions.add(line);
  }
  const allSteps = new StepTally();
  for (const line of selection.steps) {
    allSteps.add(line);
    // A skipped step would only open an empty group ("(no site)", 0 and 0).
    if (!stepGrouping || !ranToAnEnd(line)) continue;
    group(stepGroupKey(by, line, selection.attribution.get(line)), line.t).steps?.add(line);
  }

  const rows = [...groups.values()];
  if (by === 'prompt') {
    rows.sort((a, b) => promptRank(a) - promptRank(b) || a.first - b.first || a.last - b.last);
  } else {
    rows.sort(
      (a, b) =>
        b.actions.actions - a.actions.actions
        || (b.steps?.executed ?? 0) - (a.steps?.executed ?? 0)
        || (a.key === null ? 1 : 0) - (b.key === null ? 1 : 0)
        || (a.key ?? '').localeCompare(b.key ?? ''),
    );
  }

  return {
    by,
    groups: rows.map((acc) => ({
      key: acc.key,
      ...(acc.keyless !== undefined && { keyless: acc.keyless }),
      firstSeen: new Date(acc.first).toISOString(),
      lastSeen: new Date(acc.last).toISOString(),
      actions: acc.actions.finish(),
      ...(acc.steps !== undefined && { steps: acc.steps.finish() }),
    })),
    actions: allActions.finish(),
    steps: allSteps.finish(),
  };
}

// ── Links to the report ──────────────────────────────────────────────────────

/**
 * The report's anchor for one step card (§8.3): `step-11`, `row-3-step-11` in
 * a data-row report, and for a hook's step its scope and place in the scope
 * (`hook-beforeEach-2-step-5`).
 *
 * The report generator builds its ids with the same `stepAnchor`
 * (src/report/anchors.ts), so the two cannot drift apart.
 */
export function reportAnchor(at: StepAnchorFields): string {
  return stepAnchor(at);
}

/**
 * A report as a link a terminal or an editor can open: a `file:` URL, with the
 * step's anchor after `#` when there is one. A Windows path with `#anchor`
 * stuck on the end opens nothing (and a space in it ends the link early); the
 * URL escapes both.
 */
export function reportHref(file: string, anchor?: string): string {
  let url: string;
  try {
    url = pathToFileURL(file).href;
  } catch {
    url = file;
  }
  return anchor === undefined ? url : `${url}#${anchor}`;
}

/** Where a line's report is, if anywhere. */
export type ReportLink =
  /** The report is on disk: `href` is its `file:` URL and the step's anchor. */
  | { state: 'linked'; path: string; anchor: string; href: string }
  /** The report is on disk but has no card for this step (`card: false`):
   *  `href` opens the report at the top. */
  | { state: 'no-card'; path: string; anchor: null; href: string }
  /** The run line names a report that is no longer there (§8.4). */
  | { state: 'deleted'; path: string }
  /** The run ended and wrote no report (an errand, an ad hoc batch). */
  | { state: 'none' }
  /** No run line yet, and the run wrote a line in the last day: it may still
   *  be going. */
  | { state: 'pending' }
  /** No run line, and nothing from the run for over a day: it crashed, or was
   *  killed, before it could write one. */
  | { state: 'unfinished' };

export type ReportExists = (file: string) => boolean;

/** How long a run with no run line can go quiet before it reads as one that
 *  did not finish rather than one still going. */
export const UNFINISHED_AFTER_MS = DAY_MS;

/** `exists`, asked at most once per path. */
function memoExists(exists: ReportExists): ReportExists {
  const seen = new Map<string, boolean>();
  return (file) => {
    let known = seen.get(file);
    if (known === undefined) {
      try {
        known = exists(file);
      } catch {
        known = false;
      }
      seen.set(file, known);
    }
    return known;
  };
}

function linkFor(
  line: StatsActionLine | StatsStepLine,
  selection: StatsSelection,
  exists: ReportExists,
  now: Date | undefined,
): ReportLink {
  const run = selection.runs.get(line.run);
  if (run === undefined) {
    const quiet = selection.lastSeen.get(line.run);
    return now !== undefined && quiet !== undefined && now.getTime() - quiet > UNFINISHED_AFTER_MS
      ? { state: 'unfinished' }
      : { state: 'pending' };
  }
  if (typeof run.report !== 'string' || run.report === '') return { state: 'none' };
  if (!exists(run.report)) return { state: 'deleted', path: run.report };
  if (line.card === false || selection.noCard.has(stepKey(line))) {
    return { state: 'no-card', path: run.report, anchor: null, href: reportHref(run.report) };
  }
  const anchor = reportAnchor(line);
  return { state: 'linked', path: run.report, anchor, href: reportHref(run.report, anchor) };
}

// ── Lists ────────────────────────────────────────────────────────────────────

export interface StatsList<E> {
  /** Entries before the limit. */
  total: number;
  entries: E[];
}

interface Where {
  t: string;
  run: string;
  project: string;
  test: string | null;
  step: number;
  row?: number;
  hook?: StatsStepLine['hook'];
  /** The step's place in its hook scope, from 1. */
  hookIndex?: number;
  /** The execution the line belongs to (§5.1), when the line carries one. */
  exec?: number;
  stepText?: string;
}

function whereOf(line: StatsActionLine | StatsStepLine): Where {
  const exec = execOf(line);
  return {
    t: line.t,
    run: line.run,
    project: line.project,
    test: line.test ?? null,
    step: line.step,
    ...(line.row !== undefined && { row: line.row }),
    ...(line.hook !== undefined && { hook: line.hook }),
    ...(line.hookIndex !== undefined && { hookIndex: line.hookIndex }),
    ...(exec !== undefined && { exec }),
    ...(line.stepText !== undefined && { stepText: line.stepText }),
  };
}

export interface FailureEntry extends Where {
  attempt: number;
  turn: number;
  action: string;
  selector: string | null;
  form: SelectorForm | null;
  outcome: LineOutcome;
  matchCount?: number;
  site?: string;
  model?: string;
  report: ReportLink;
}

export interface CostlyEntry extends Where {
  status: StatsStepLine['status'];
  tolerated?: true;
  interrupted?: true;
  firstTry: boolean;
  attempts: number;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached?: number;
  /** `tokensIn + tokensOut`, what the list is sorted by. */
  tokens: number;
  estimated: boolean;
  report: ReportLink;
}

export interface ListOptions {
  /** Entries to return; the rest are counted in `total`. */
  limit: number;
  /** Whether a report file is still there; `fs.existsSync` in the CLI. */
  reportExists: ReportExists;
  /** The time now, which tells a run still going from one that did not
   *  finish. Without it, a run with no run line is always `pending`. */
  now?: Date | undefined;
}

/** Newest first: by `t`, and among equal times the line written later. */
function newestFirst<L extends { t: string }>(lines: readonly L[]): Array<{ line: L; ms: number; i: number }> {
  return lines.map((line, i) => ({ line, ms: Date.parse(line.t), i }));
}

function limitOf(limit: number): number {
  return Number.isInteger(limit) && limit > 0 ? limit : 0;
}

/** Failed actions (any outcome but `ok`), newest first, each with the report
 *  that shows why. */
export function listFailures(selection: StatsSelection, opts: ListOptions): StatsList<FailureEntry> {
  const exists = memoExists(opts.reportExists);
  const failed = newestFirst(selection.actions.filter((line) => isFailure(line.outcome)));
  failed.sort((a, b) => b.ms - a.ms || b.i - a.i);
  const entries = failed.slice(0, limitOf(opts.limit)).map(({ line }): FailureEntry => ({
    ...whereOf(line),
    attempt: line.attempt,
    turn: line.turn,
    action: line.action,
    selector: line.selector ?? null,
    form: line.form ?? null,
    outcome: line.outcome,
    ...(line.matchCount !== undefined && { matchCount: line.matchCount }),
    ...(line.site !== undefined && { site: line.site }),
    ...(line.model !== undefined && { model: line.model }),
    report: linkFor(line, selection, exists, opts.now),
  }));
  return { total: failed.length, entries };
}

/** The steps that used the most tokens, newest first among equals. A step
 *  with no token count (code, a tool, usage never reported) is not listed. */
export function listCostly(selection: StatsSelection, opts: ListOptions): StatsList<CostlyEntry> {
  const exists = memoExists(opts.reportExists);
  const priced = newestFirst(selection.steps)
    .map((entry) => ({ ...entry, tokens: count(entry.line.tokensIn) + count(entry.line.tokensOut) }))
    .filter((entry) => entry.tokens > 0);
  priced.sort((a, b) => b.tokens - a.tokens || b.ms - a.ms || b.i - a.i);
  const entries = priced.slice(0, limitOf(opts.limit)).map(({ line, tokens }): CostlyEntry => ({
    ...whereOf(line),
    status: line.status,
    ...(line.tolerated === true && { tolerated: true }),
    ...(line.interrupted === true && { interrupted: true }),
    firstTry: line.firstTry === true,
    attempts: count(line.attempts),
    calls: count(line.calls),
    tokensIn: count(line.tokensIn),
    tokensOut: count(line.tokensOut),
    ...(line.tokensCached !== undefined && { tokensCached: count(line.tokensCached) }),
    tokens,
    estimated: line.tokensEstimated === true,
    report: linkFor(line, selection, exists, opts.now),
  }));
  return { total: priced.length, entries };
}
