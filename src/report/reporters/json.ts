import {
  countSteps,
  rowOutcome,
  stepAnchorOf,
  stepRow,
  stripAnsi,
  testOutcome,
  videoPathFor,
} from './results.js';
import type { Outcome } from './results.js';
import { isHealedStep } from '../types.js';
import type { StepResult, TestReport } from '../types.js';
import type { RunState, RunTestEntry } from './types.js';

// The shape of `run.json` (docs/specs/SPEC-reporters.md §7): the run's tests
// and their steps, in a form a script can read. A summary — no sub-actions,
// DOM, AI messages or screenshots.

/** Goes up when a field is removed or changes meaning; adding one does not (§7). */
export const RUN_JSON_SCHEMA_VERSION = 1;

export type RunJsonStatus = 'passed' | 'failed' | 'stopped' | 'notRun';

export interface RunJsonStep {
  row?: number;
  step: number;
  text: string;
  status: StepResult['status'];
  durationMs: number;
  source: 'code' | 'ai';
  /** The hook scope, for a hook's line rather than a step of the test. */
  hook?: string;
  healed?: true;
  tolerated?: true;
  /** The step in flight when the user stopped the run; its status is `failed`. */
  stopped?: true;
}

export interface RunJsonFailure {
  row?: number;
  /** The hook scope, when the failing step is a hook's line; `step` is then the step it ran beside. */
  hook?: string;
  step?: number;
  text?: string;
  error?: string;
  reportAnchor?: string;
}

export interface RunJsonRow {
  row: number;
  status: RunJsonStatus;
  durationMs: number;
  tokens: number;
  values: Record<string, string>;
  video?: string;
}

export interface RunJsonTest {
  title: string;
  file: string;
  tags: string[];
  status: RunJsonStatus;
  durationMs: number;
  tokens: number;
  report?: string;
  healedSteps?: number;
  toleratedSteps?: number;
  skippedSteps?: number;
  video?: string;
  rows?: RunJsonRow[];
  failure?: RunJsonFailure;
  diagnosis?: {
    rootCause: string;
    faultCategory: string;
    suggestedFix: string;
    confidence: string;
  };
  steps: RunJsonStep[];
}

export interface RunJson {
  schemaVersion: number;
  steptix: { version: string; commit: string | null };
  startedAt: string;
  finished: boolean;
  durationMs: number;
  /** Null until the run's last write, the only one that knows it. */
  exitCode: number | null;
  totals: {
    tests: number;
    passed: number;
    failed: number;
    stopped: number;
    notRun: number;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    healedSteps: number;
  };
  tests: RunJsonTest[];
}

/**
 * `run.json` for a run, as it stands (docs/specs/SPEC-reporters.md §7).
 * Pretty-printed with two spaces, ending in a newline.
 */
export function renderRunJson(state: RunState): string {
  return `${JSON.stringify(buildRunJson(state), null, 2)}\n`;
}

/** The object `renderRunJson` writes. */
export function buildRunJson(state: RunState): RunJson {
  const tests = state.tests.map(jsonTest);
  const reports = state.tests.flatMap((t) => (t.state === 'done' && t.report ? [t.report] : []));
  return {
    schemaVersion: RUN_JSON_SCHEMA_VERSION,
    steptix: { version: state.steptix.version, commit: state.steptix.commit },
    startedAt: state.startedAt,
    finished: state.finished,
    durationMs: state.durationMs,
    exitCode: state.exitCode ?? null,
    totals: {
      tests: tests.length,
      passed: tests.filter((t) => t.status === 'passed').length,
      failed: tests.filter((t) => t.status === 'failed').length,
      stopped: tests.filter((t) => t.status === 'stopped').length,
      notRun: tests.filter((t) => t.status === 'notRun').length,
      tokens: sum(reports.map((r) => r.tokensUsed)),
      inputTokens: sum(reports.map((r) => r.inputTokens)),
      outputTokens: sum(reports.map((r) => r.outputTokens)),
      healedSteps: sum(tests.map((t) => t.healedSteps ?? 0)),
    },
    tests,
  };
}

function jsonTest(entry: RunTestEntry): RunJsonTest {
  const base = {
    title: stripAnsi(entry.title),
    file: entry.file,
    tags: entry.tags,
  };
  const notRun = { ...base, status: 'notRun' as const, durationMs: 0, tokens: 0, steps: [] };
  switch (entry.state) {
    case 'notRun':
      return notRun;
    case 'parseError':
      return { ...notRun, failure: { error: stripAnsi(entry.message ?? '') } };
    case 'runError':
      // It started, so it failed — with whatever it threw (§8.1).
      return { ...notRun, status: 'failed', failure: { error: stripAnsi(entry.message ?? '') } };
    case 'done':
      return entry.report ? ranTest(base, entry.report, entry.reportFile) : notRun;
  }
}

function ranTest(
  base: Pick<RunJsonTest, 'title' | 'file' | 'tags'>,
  report: TestReport,
  reportFile: string | undefined,
): RunJsonTest {
  const counts = countSteps(report.steps, report);
  const rows = report.rows && report.rows.length > 0 ? report.rows : undefined;
  const rowResults = rows?.map((row) => ({ row, outcome: rowOutcome(report, row) }));

  let status: RunJsonStatus;
  let failure: RunJsonFailure | undefined;
  if (rowResults) {
    status =
      report.aborted || rowResults.some((r) => r.outcome.kind === 'stopped')
        ? 'stopped'
        : rowResults.some((r) => isFailure(r.outcome)) || report.status === 'failed'
          ? 'failed'
          : 'passed';
    const failed =
      rowResults.find((r) => r.outcome.kind === 'failedStep') ??
      rowResults.find((r) => r.outcome.kind === 'runError');
    failure = failed ? failureOf(report, failed.outcome, failed.row.index) : undefined;
  } else {
    const outcome = testOutcome(report);
    status = statusOf(outcome);
    failure = failureOf(report, outcome, undefined);
  }

  const d = report.diagnosis;
  return {
    ...base,
    status,
    durationMs: report.durationMs,
    tokens: report.tokensUsed,
    ...(reportFile !== undefined && { report: reportFile }),
    ...(counts.healed > 0 && { healedSteps: counts.healed }),
    ...(counts.tolerated > 0 && { toleratedSteps: counts.tolerated }),
    ...(counts.skipped > 0 && { skippedSteps: counts.skipped }),
    ...(report.videoRelPath !== undefined && { video: videoPathFor(reportFile, report.videoRelPath) }),
    ...(rowResults && {
      rows: rowResults.map(({ row, outcome }) => ({
        row: row.index,
        status: statusOf(outcome),
        durationMs: row.durationMs,
        tokens: row.tokensUsed,
        values: mapValues(row.values, stripAnsi),
        ...(row.videoRelPath !== undefined && { video: videoPathFor(reportFile, row.videoRelPath) }),
      })),
    }),
    ...(failure && { failure }),
    ...(d && {
      diagnosis: {
        rootCause: stripAnsi(d.rootCause),
        faultCategory: d.faultCategory,
        suggestedFix: stripAnsi(d.suggestedFix),
        confidence: d.confidence,
      },
    }),
    steps: report.steps.map((s) => jsonStep(s, rows !== undefined)),
  };
}

function isFailure(outcome: Outcome): boolean {
  return outcome.kind === 'failedStep' || outcome.kind === 'runError';
}

function statusOf(outcome: Outcome): RunJsonStatus {
  switch (outcome.kind) {
    case 'failedStep':
    case 'runError':
      return 'failed';
    case 'stopped':
      return 'stopped';
    case 'skipped':
      return 'notRun';
    case 'passed':
      return 'passed';
  }
}

function failureOf(report: TestReport, outcome: Outcome, row: number | undefined): RunJsonFailure | undefined {
  const rowField = row !== undefined ? { row } : {};
  if (outcome.kind === 'failedStep') {
    const step = outcome.step;
    return {
      ...rowField,
      ...(step.hookScope !== undefined && { hook: step.hookScope }),
      step: step.index,
      text: stripAnsi(step.instruction),
      ...(step.error !== undefined && { error: stripAnsi(step.error) }),
      reportAnchor: stepAnchorOf(report, step),
    };
  }
  if (outcome.kind === 'runError') return { ...rowField, error: stripAnsi(outcome.message) };
  return undefined;
}

function jsonStep(step: StepResult, dataDriven: boolean): RunJsonStep {
  const row = dataDriven ? stepRow(step) : undefined;
  return {
    ...(row !== undefined && { row }),
    step: step.index,
    text: stripAnsi(step.instruction),
    status: step.status,
    durationMs: step.durationMs,
    source: step.fromCodeBehind ? 'code' : 'ai',
    ...(step.hookScope !== undefined && { hook: step.hookScope }),
    ...(isHealedStep(step) && { healed: true as const }),
    ...(step.tolerated && { tolerated: true as const }),
    ...(step.interrupted && { stopped: true as const }),
  };
}

function mapValues(values: Record<string, string>, f: (v: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, f(v)]));
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
