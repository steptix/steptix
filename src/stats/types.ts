/**
 * The scoreboard's lines (docs/specs/SPEC-scoreboard.md §5, §8.2).
 *
 * Three kinds share one month file: an action line per action the model chose,
 * a step line per executed step, and a run line when the run ends. Each is one
 * JSON object with `v: 1` and a `kind`, and a reader groups them by `run`.
 *
 * The flags that can only ever say yes (`truncated`, `imported`,
 * `tokensEstimated`, `tolerated`, `interrupted`, `aborted`) are typed `true`
 * and are absent otherwise, so a line that does not carry one is the common
 * case, not a `false` written on every line. `card` is the one flag that can
 * only ever say no, for the same reason.
 */
import type { StepStatus } from '../report/types.js';

/**
 * How the selector found its element (§5.3), decided by
 * `classifySelectorForm`. The raw selector is kept beside it, so old lines can
 * be regrouped if the rules change.
 */
export type SelectorForm =
  | 'role'
  | 'css-role-name'
  | 'text-is'
  | 'has-text'
  | 'text-engine'
  | 'testid'
  | 'aria-label'
  | 'id'
  | 'name-attr'
  | 'href'
  | 'positional'
  /** Reserved for picking elements by snapshot reference (§16). */
  | 'ref'
  | 'css-other';

/**
 * What became of one action (§5.4), decided by `classifyOutcome`.
 *
 * `invalid-selector`, `no-match`, `blocked`, `ambiguous` and `timeout` are read
 * off Playwright's own error text, so they are only ever given to an error that
 * came from the browser action layer. Every other error is `other` — or one of
 * the two outcomes decided by the action's STRUCTURE rather than its text:
 *
 * - `assert-failed` — an assertion that evaluated false: a page `assert` whose
 *   generated code answered false, or a computer-surface `assert` the model
 *   judged not to hold.
 * - `conceded` — the model reported the step could not be done: a page `assert`
 *   carrying `"holds": false`, which nothing evaluated.
 */
export type StatsOutcome =
  | 'ok'
  | 'unknown-action'
  | 'invalid-selector'
  | 'no-match'
  | 'blocked'
  | 'ambiguous'
  | 'timeout'
  | 'assert-failed'
  | 'conceded'
  | 'other';

/**
 * Who ran it (§5.6). `user` is the default and the only suite the default view
 * shows; the others are the live integration suite, the simple-steps bench and
 * a compile's recording run, each tagged so it cannot swamp the user's own
 * numbers.
 */
export type StatsSuite = 'user' | 'live' | 'bench' | 'compile';

/** What drove the step (§5.6): the model, or a code-behind replay. */
export type StatsSource = 'ai' | 'code';

/** The fields an action line and a step line share (§5.1, §5.2). */
export interface StatsStepFields {
  v: 1;
  /** ISO 8601 UTC, as `toISOString()` writes it (milliseconds included, so a
   *  step's actions sort in order): when the action finished, or when the step
   *  ended. */
  t: string;
  /** The run id (§8.1), the join key to the run line and its report. */
  run: string;
  /** The project root, as an absolute path. */
  project: string;
  /** The test file relative to the project root, with forward slashes, or
   *  `null` for ad hoc steps. */
  test: string | null;
  /** The step number as the report shows it. */
  step: number;
  /**
   * Which execution of a step this line belongs to: 1-based, unique within the
   * run, and shared by a step line and ITS action lines — the join key between
   * them, beside `run`. A loop body's second pass, a data row's second step 3
   * and a `beforeEach` line run beside every step are each a new execution with
   * a new number, where `step` repeats. Written on every line this recorder
   * makes; absent only on a line written before it.
   */
  exec: number;
  /** The data row, when the run has rows. */
  row?: number;
  /**
   * Set on a hook's step (`StepResult.hookScope`). A hook step reuses the
   * number of the step it wraps (0 for `before`, the
   * last + 1 for `after`), so without this a `beforeEach` step's line is
   * indistinguishable from the step it ran before — the report keeps hooks
   * out of its counts for the same reason.
   */
  hook?: 'before' | 'beforeEach' | 'afterEach' | 'after';
  /**
   * Which line of its hook scope the step is, 1-based (`StepResult.hookIndex`).
   * Every line of one scope shares `step` and `hook`, so this is what tells
   * two `beforeEach` lines apart — and what the
   * report's anchor for a hook step is built from
   * (`hook-beforeEach-2-step-5`, src/report/anchors.ts). Absent on a line
   * written before it, and on every non-hook step.
   */
  hookIndex?: number;
  /**
   * The step as authored — placeholders intact, secrets masked (§5.7) — cut to
   * 500 characters. Absent only on a line that would not otherwise fit in
   * 4 KB (§6.2), which then carries `truncated`.
   */
  stepText?: string;
  /**
   * The rules fingerprint (§5.5). `null` on imported lines, whose report
   * carries none (§10). Absent on a line whose step made no model call — a
   * code-behind replay was never shown the rules — and on a step asked through
   * a prompt of its own (a `[use ai]` step, the computer surface).
   */
  prompt?: string | null;
  /** Framework version and commit, when known (§5.5). */
  fw?: string;
  /**
   * Host of the page, masked like the report masks a URL. On an action line,
   * the page the action ran on. On a step line, the step's first action line's
   * site, or failing that the page its first model call was made on. Absent
   * when there was no page with a host (`about:blank`, the computer surface).
   */
  site?: string;
  /**
   * The model. On an action line, the model that chose the action. On a step
   * line, the step's first action line's model, or failing that its first
   * model call's.
   */
  model?: string;
  /**
   * `false` when the report has no card for this step, so there is no anchor
   * to link to: the branch steps of a watch group on the Sessions API, whose
   * report writes no row for them. Absent — never `true` — on every other line.
   */
  card?: false;
  suite: StatsSuite;
  source: StatsSource;
  /** Set when `stepText` or `selector` was cut, or a field was dropped to keep
   *  the line under 4 KB. */
  truncated?: true;
  /** Written by `aiui stats import` from a report on disk (§10). */
  imported?: true;
}

/** One action the model chose, per execution (§5.1). */
export interface StatsActionLine extends StatsStepFields {
  kind: 'action';
  /** Step-level attempt, from 1. */
  attempt: number;
  /** Turn within the attempt, from 1. */
  turn: number;
  /** The action type as the model wrote it. */
  action: string;
  /** The selector as the model wrote it, masked (§5.7); `null` for an action
   *  with none (`navigate`, `keypress`, a wait on a URL). */
  selector: string | null;
  form: SelectorForm | null;
  outcome: StatsOutcome;
  /** Elements the selector matched, when the run measured it. */
  matchCount?: number;
  /** How long the action took. */
  ms: number;
}

/**
 * One executed step, written when it ends (§5.2) — but only a step that asked
 * the model something, or a code-behind replay (`source: 'code'`). A step
 * that made no model call (a flow-control condition this run's values
 * answered, a `[use ai]` line refused before it was sent, a step that failed
 * because the run has no AI) writes no line, and neither do its actions.
 */
export interface StatsStepLine extends StatsStepFields {
  kind: 'step';
  status: StepStatus;
  /** A failure the run carried on past (`otherwise continue`). */
  tolerated?: true;
  /** The step a Stop cut short. Its `status` is `failed`, and the run line's
   *  `failed` does not count it. */
  interrupted?: true;
  attempts: number;
  /** Model turns across all attempts. */
  turns: number;
  /** Passed on attempt 1 with no failed action — the headline number. */
  firstTry: boolean;
  ms: number;
  /** Model calls the step made, every purpose and attempt together. */
  calls: number;
  tokensIn: number;
  tokensOut: number;
  /** Input tokens served from the provider's prompt cache, when it reports
   *  them. */
  tokensCached?: number;
  /** At least one summed call's usage was the client's estimate (§7.1). */
  tokensEstimated?: true;
}

/** One run, written where the run's report is written (§8.2). */
export interface StatsRunLine {
  v: 1;
  kind: 'run';
  t: string;
  run: string;
  project: string;
  test: string | null;
  suite: StatsSuite;
  /** The run's status: a `StepStatus` for a test run; a batch that is not a
   *  test run may report its own word. */
  status: string;
  /** The user stopped the run. */
  aborted?: true;
  steps: number;
  firstTry: number;
  failed: number;
  /** The run's totals from its token tracker, including calls that belong to
   *  no step. */
  tokensIn?: number;
  tokensOut?: number;
  /** Absolute path of the HTML report, or `null` when the run wrote none. */
  report: string | null;
  imported?: true;
}

export type StatsLine = StatsActionLine | StatsStepLine | StatsRunLine;
