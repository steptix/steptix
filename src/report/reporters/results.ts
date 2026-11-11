import path from 'node:path';
import { canonicalStepAnchor, stepCardIds } from '../anchors.js';
import { countStepOrigins } from '../generator.js';
import { isHealedStep } from '../types.js';
import type { RowSummaryLine, StepResult, TestReport } from '../types.js';

// What the JUnit and JSON writers both need to know about a test's or a row's
// result (docs/specs/SPEC-reporters.md §6.2, §7), worked out once so the two
// files cannot disagree about it.

/** The `<skipped>` message for a test or row `--bail` stopped the run reaching (§6.2). */
export const BAIL_SKIP_MESSAGE = 'Not run: the run stopped at the first failure (--bail).';

/** The not-run error's message (§8, step 1). */
export const NOT_RUN_MESSAGE = 'The run ended before this test ran.';

/** The stopped error's message, for a test or row the user stopped. */
export const STOPPED_MESSAGE = 'The run was stopped by the user.';

/** A failed test or row with no failing step and no error to say why. */
export const FAILED_WITHOUT_STEP_MESSAGE = 'The test failed before any step failed.';

// CSI sequences (`ESC [ … m` and the rest of the family, also the one-byte
// 0x9B introducer) and OSC sequences (`ESC ] … BEL` or `ESC ] … ESC \`), which
// is what terminal colour and hyperlink codes are made of.
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * Remove terminal colour codes. Browser errors carry them, and a CI page or a
 * script would otherwise show `[31m` in the middle of the text (§6.4).
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Whether a step is one of the test's own steps rather than a hook's line or
 * a step typed at the interactive prompt — the same rows `countStepOrigins`
 * leaves out, so the counts here add up the way the HTML report's do.
 */
export function isTestStep(step: StepResult): boolean {
  return !step.hookScope && !step.interactiveAdHoc && !step.interactiveChild;
}

/**
 * The data row a step ran in: `dataRow`, else a run row's loop marker, which
 * is how the HTML report reads it when it builds the step's anchor.
 */
export function stepRow(step: StepResult): number | undefined {
  return step.dataRow ?? (step.loop?.kind === 'row' ? step.loop.index : undefined);
}

/** The steps of one data row of a merged report. */
export function stepsOfRow(report: TestReport, row: number): StepResult[] {
  return report.steps.filter((s) => stepRow(s) === row);
}

/**
 * The failing step: the first one whose status is `failed` and which is not
 * tolerated (§6.2).
 */
export function firstFailingStep(steps: StepResult[]): StepResult | undefined {
  return steps.find((s) => s.status === 'failed' && !s.tolerated);
}

/**
 * The id the step's card carries in the report's HTML (`step-6`,
 * `row-2-step-6`, or `step-6-3` for the third pass of a loop that ran it).
 * `step` is one of `report.steps`; the ids are the ones the generator gives
 * those steps' cards, from the same {@link stepCardIds}.
 */
export function stepAnchorOf(report: Pick<TestReport, 'steps'>, step: StepResult): string {
  return stepCardIds(report.steps).get(step) ?? canonicalStepAnchor(step);
}

/** The test's own steps that healed under AI after their code-behind threw. */
export function healedStepsOf(steps: StepResult[]): StepResult[] {
  return steps.filter((s) => isTestStep(s) && isHealedStep(s));
}

/** The numbers a testcase's properties (§6.3) and a JSON test carry. */
export interface StepCounts {
  /** The test's own steps that ran: every one not skipped. */
  steps: number;
  /** Of those, how many ran from code-behind. */
  stepsFromCode: number;
  healed: number;
  tolerated: number;
  skipped: number;
}

/**
 * Count steps for a test or a row.
 *
 * Given a whole report, `healed`, `tolerated` and `skipped` take the report's
 * own figures when it has them, the way `countHealedSteps` in run.ts does, so
 * the files agree with the exit code. A row has no figures of its own, so they
 * are counted off its steps.
 *
 * A data-driven report's `healedSteps` is not a sum: `mergeRowReports` sums
 * the other counts but keeps the first row's `healedSteps`. So for a report
 * with rows the healed steps are always counted off the steps.
 */
export function countSteps(steps: StepResult[], report?: TestReport): StepCounts {
  const ran = steps.filter((s) => isTestStep(s) && s.status !== 'skipped');
  const origins = countStepOrigins(ran);
  const stale = countStepOrigins(steps).stale;
  const tolerated = steps.filter((s) => s.status === 'failed' && s.tolerated).length;
  const skipped = steps.filter((s) => s.status === 'skipped').length;
  const dataDriven = report?.rows !== undefined && report.rows.length > 0;
  return {
    steps: ran.length,
    stepsFromCode: origins.code,
    healed: dataDriven ? stale : (report?.healedSteps ?? stale),
    tolerated: report?.toleratedSteps ?? tolerated,
    skipped: report?.skippedSteps ?? skipped,
  };
}

/**
 * The result of a test that ran, or of one of its rows, in the terms of the
 * table in §6.2. `healed` on a pass lists the steps that healed; whether that
 * is a failure is the writer's to decide from `failOnHealed`.
 */
export type Outcome =
  | { kind: 'passed'; healedCount: number; healed: StepResult[] }
  | { kind: 'failedStep'; step: StepResult }
  | { kind: 'runError'; message: string }
  | { kind: 'stopped'; step: StepResult | undefined }
  | { kind: 'skipped' };

/** The result of a test without rows, or of a data-driven test as a whole. */
export function testOutcome(report: TestReport): Outcome {
  const failing = firstFailingStep(report.steps);
  if (report.aborted) {
    return { kind: 'stopped', step: report.steps.find((s) => s.interrupted) };
  }
  if (failing?.interrupted) return { kind: 'stopped', step: failing };
  if (failing) return { kind: 'failedStep', step: failing };
  if (report.error !== undefined) return { kind: 'runError', message: report.error };
  if (report.status === 'failed') return { kind: 'runError', message: FAILED_WITHOUT_STEP_MESSAGE };
  if (report.status === 'skipped') return { kind: 'skipped' };
  const counts = countSteps(report.steps, report);
  return { kind: 'passed', healedCount: counts.healed, healed: healedStepsOf(report.steps) };
}

/**
 * The result of one row of a data-driven test, from that row's line and its
 * own steps. A row the line marks `skipped` never ran: `steptix run` leaves a
 * row unrun only when `--bail` stopped it. The report's `error` and `aborted`
 * are the first row's (`mergeRowReports` spreads that row's report), so a row
 * is stopped by its own interrupted step and a failed row with no failing step
 * borrows the report's `error` only as the best text there is.
 */
export function rowOutcome(report: TestReport, row: RowSummaryLine): Outcome {
  if (row.status === 'skipped') return { kind: 'skipped' };
  const steps = stepsOfRow(report, row.index);
  const failing = firstFailingStep(steps);
  if (failing?.interrupted) return { kind: 'stopped', step: failing };
  if (failing) return { kind: 'failedStep', step: failing };
  if (row.status === 'failed') {
    return { kind: 'runError', message: report.error ?? FAILED_WITHOUT_STEP_MESSAGE };
  }
  const healed = healedStepsOf(steps);
  return { kind: 'passed', healedCount: healed.length, healed };
}

/**
 * A video's path relative to the folder the two files are written in. The
 * report holds it relative to the HTML report, which `reportFile` locates
 * within that folder.
 */
export function videoPathFor(reportFile: string | undefined, videoRelPath: string): string {
  if (reportFile === undefined) return videoRelPath;
  const dir = path.posix.dirname(reportFile);
  return dir === '.' ? videoRelPath : path.posix.join(dir, videoRelPath);
}

/** The first line of a message, for an attribute that has room for one. */
export function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  return line.trim();
}
