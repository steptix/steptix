import {
  BAIL_SKIP_MESSAGE,
  NOT_RUN_MESSAGE,
  STOPPED_MESSAGE,
  countSteps,
  firstLine,
  rowOutcome,
  stepAnchorOf,
  stepsOfRow,
  stripAnsi,
  testOutcome,
  videoPathFor,
} from './results.js';
import type { Outcome } from './results.js';
import type { RowSummaryLine, StepResult, TestReport } from '../types.js';
import type { RunState, RunTestEntry } from './types.js';

/**
 * `junit.xml` for a run, as it stands (docs/specs/SPEC-reporters.md §6).
 *
 * One testsuite per run, one testcase per test, or per row of a data-driven
 * test. A test that has not run yet is an error, so a file read before the run
 * ends never says nothing failed (§8).
 */
export function renderJUnit(state: RunState): string {
  const cases = state.tests.flatMap((entry) => testcasesFor(entry, state));
  const counts = {
    tests: cases.length,
    failures: cases.filter((c) => c.result?.element === 'failure').length,
    errors: cases.filter((c) => c.result?.element === 'error').length,
    skipped: cases.filter((c) => c.result?.element === 'skipped').length,
  };
  const name = attr(state.suiteName);
  const time = seconds(state.durationMs);
  const totals =
    `tests="${counts.tests}" failures="${counts.failures}" errors="${counts.errors}" ` +
    `skipped="${counts.skipped}" time="${time}"`;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${name}" ${totals}>`,
    `  <testsuite name="${name}" ${totals} timestamp="${attr(state.startedAt)}">`,
    ...cases.map(renderTestcase),
    '  </testsuite>',
    '</testsuites>',
  ];
  return `${lines.join('\n')}\n`;
}

/** One `<failure>`, `<error>` or `<skipped>` element, or none for a pass. */
interface CaseResult {
  element: 'failure' | 'error' | 'skipped';
  type?: string;
  message: string;
  /** The element's text; absent writes an empty element. */
  body?: string;
}

interface Testcase {
  name: string;
  file: string;
  durationMs: number;
  /** Absent for a pass. */
  result?: CaseResult;
  properties: Array<[string, string]>;
  /** The `[[ATTACHMENT|…]]` paths for `<system-out>`. */
  attachments: string[];
}

function testcasesFor(entry: RunTestEntry, state: RunState): Testcase[] {
  const base = { name: entry.title, file: entry.file, durationMs: 0, properties: [], attachments: [] };
  switch (entry.state) {
    case 'notRun':
      return [
        {
          ...base,
          result:
            state.finished && state.bailed
              ? { element: 'skipped', message: BAIL_SKIP_MESSAGE }
              : { element: 'error', type: 'not-run', message: NOT_RUN_MESSAGE },
        },
      ];
    case 'parseError':
    case 'runError': {
      const message = stripAnsi(entry.message ?? '');
      return [
        {
          ...base,
          result: {
            element: 'error',
            type: entry.state === 'parseError' ? 'parse' : 'run',
            message: firstLine(message),
            body: message,
          },
        },
      ];
    }
    case 'done':
      // A `done` entry always carries its report; without one there is nothing
      // to say it ran, so it reads as not run rather than as a pass.
      if (!entry.report) {
        return [{ ...base, result: { element: 'error', type: 'not-run', message: NOT_RUN_MESSAGE } }];
      }
      return entry.report.rows && entry.report.rows.length > 0
        ? entry.report.rows.map((row) => rowTestcase(entry, entry.report!, row, state))
        : [plainTestcase(entry, entry.report, state)];
  }
}

function plainTestcase(entry: RunTestEntry, report: TestReport, state: RunState): Testcase {
  const counts = countSteps(report.steps, report);
  const video = report.videoRelPath !== undefined ? videoPathFor(entry.reportFile, report.videoRelPath) : undefined;
  const result = resultFor(testOutcome(report), report, entry.reportFile, state.failOnHealed, true);
  return {
    name: entry.title,
    file: entry.file,
    durationMs: report.durationMs,
    ...(result && { result }),
    properties: properties(entry.reportFile, report.tokensUsed, counts, video, {}),
    attachments: attachments(entry.reportFile, video),
  };
}

function rowTestcase(entry: RunTestEntry, report: TestReport, row: RowSummaryLine, state: RunState): Testcase {
  const name = `${entry.title} [row ${row.index}]`;
  const outcome = rowOutcome(report, row);
  if (outcome.kind === 'skipped') {
    return {
      name,
      file: entry.file,
      durationMs: 0,
      result: { element: 'skipped', message: BAIL_SKIP_MESSAGE },
      properties: [],
      attachments: [],
    };
  }
  const counts = countSteps(stepsOfRow(report, row.index));
  const video = row.videoRelPath !== undefined ? videoPathFor(entry.reportFile, row.videoRelPath) : undefined;
  // No diagnosis here: the report holds one, and it does not say which row it
  // is about (§6.2).
  const result = resultFor(outcome, report, entry.reportFile, state.failOnHealed, false);
  return {
    name,
    file: entry.file,
    durationMs: row.durationMs,
    ...(result && { result }),
    properties: properties(entry.reportFile, row.tokensUsed, counts, video, row.values),
    attachments: attachments(entry.reportFile, video),
  };
}

/**
 * The element a result writes (§6.2). `report` is the test's report, whose
 * step cards the `Report:` line links to; `withDiagnosis` puts its AI
 * diagnosis under a failure, for a test without rows only.
 */
function resultFor(
  outcome: Outcome,
  report: TestReport,
  reportFile: string | undefined,
  failOnHealed: boolean,
  withDiagnosis: boolean,
): CaseResult | undefined {
  const diagnosisFrom = withDiagnosis ? report : undefined;
  switch (outcome.kind) {
    case 'passed': {
      if (!failOnHealed || outcome.healedCount === 0) return undefined;
      const n = outcome.healedCount;
      const named = outcome.healed.map((s) => s.index).join(', ');
      const message =
        `${n} step${n === 1 ? '' : 's'} healed (--fail-on-healed)` +
        (named ? `: step${outcome.healed.length === 1 ? '' : 's'} ${named}` : '');
      const body = [
        message,
        ...outcome.healed.map((s) => stepLine(s)),
        ...reportLine(reportFile, undefined),
      ];
      return { element: 'failure', type: 'healed', message, body: body.join('\n') };
    }
    case 'failedStep': {
      const line = stepLine(outcome.step);
      const body = [
        line,
        ...(outcome.step.error !== undefined ? [stripAnsi(outcome.step.error)] : []),
        ...reportLine(reportFile, stepAnchorOf(report, outcome.step)),
        ...diagnosisLines(diagnosisFrom),
      ];
      return { element: 'failure', type: 'step', message: line, body: body.join('\n') };
    }
    case 'runError': {
      const message = stripAnsi(outcome.message);
      const body = [message, ...reportLine(reportFile, undefined), ...diagnosisLines(diagnosisFrom)];
      return { element: 'error', type: 'run', message: firstLine(message), body: body.join('\n') };
    }
    case 'stopped': {
      const body = [
        STOPPED_MESSAGE,
        ...(outcome.step ? [stepLine(outcome.step)] : []),
        ...reportLine(reportFile, outcome.step ? stepAnchorOf(report, outcome.step) : undefined),
      ];
      return { element: 'error', type: 'stopped', message: STOPPED_MESSAGE, body: body.join('\n') };
    }
    case 'skipped':
      return { element: 'skipped', message: 'The test was skipped.' };
  }
}

/**
 * `Step N: <step text>`, the failure's message and first line (§6.2), or
 * `<scope> hook: <text>` for a hook's line, whose number is only the step it
 * ran beside.
 */
function stepLine(step: StepResult): string {
  const text = stripAnsi(step.instruction);
  return step.hookScope !== undefined ? `${step.hookScope} hook: ${text}` : `Step ${step.index}: ${text}`;
}

function reportLine(reportFile: string | undefined, anchor: string | undefined): string[] {
  if (reportFile === undefined) return [];
  return [`Report: ${reportFile}${anchor !== undefined ? `#${anchor}` : ''}`];
}

function diagnosisLines(report: TestReport | undefined): string[] {
  const d = report?.diagnosis;
  if (!d) return [];
  return [`Cause: ${stripAnsi(d.rootCause)}`, `Category: ${d.faultCategory}`];
}

/** The testcase's properties, in the order of the table in §6.3. */
function properties(
  reportFile: string | undefined,
  tokens: number,
  counts: ReturnType<typeof countSteps>,
  video: string | undefined,
  rowValues: Record<string, string>,
): Array<[string, string]> {
  const props: Array<[string, string]> = [];
  if (reportFile !== undefined) props.push(['report', reportFile]);
  props.push(['tokens', String(tokens)]);
  props.push(['steps', String(counts.steps)]);
  props.push(['stepsFromCode', String(counts.stepsFromCode)]);
  if (counts.healed > 0) props.push(['healedSteps', String(counts.healed)]);
  if (counts.tolerated > 0) props.push(['toleratedSteps', String(counts.tolerated)]);
  if (counts.skipped > 0) props.push(['skippedSteps', String(counts.skipped)]);
  if (video !== undefined) props.push(['video', video]);
  for (const [column, value] of Object.entries(rowValues)) {
    props.push([`row.${column}`, stripAnsi(value)]);
  }
  return props;
}

function attachments(reportFile: string | undefined, video: string | undefined): string[] {
  return [...(reportFile !== undefined ? [reportFile] : []), ...(video !== undefined ? [video] : [])];
}

function renderTestcase(c: Testcase): string {
  const open =
    `    <testcase name="${attr(c.name)}" classname="${attr(c.file)}" ` +
    `file="${attr(c.file)}" time="${seconds(c.durationMs)}"`;
  const inner: string[] = [];
  if (c.result) inner.push(renderResult(c.result));
  if (c.properties.length > 0) {
    inner.push('      <properties>');
    for (const [name, value] of c.properties) {
      inner.push(`        <property name="${attr(name)}" value="${attr(value)}"/>`);
    }
    inner.push('      </properties>');
  }
  if (c.attachments.length > 0) {
    const lines = c.attachments.map((p) => `[[ATTACHMENT|${p}]]`).join('\n');
    inner.push(`      <system-out>${text(lines)}</system-out>`);
  }
  if (inner.length === 0) return `${open}/>`;
  return [`${open}>`, ...inner, '    </testcase>'].join('\n');
}

function renderResult(r: CaseResult): string {
  const type = r.type !== undefined ? ` type="${attr(r.type)}"` : '';
  const head = `      <${r.element}${type} message="${attr(r.message)}"`;
  return r.body === undefined ? `${head}/>` : `${head}>${text(r.body)}</${r.element}>`;
}

/** Seconds with three decimals, the form JUnit readers expect. */
function seconds(ms: number): string {
  return (Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000).toFixed(3);
}

// Every character XML 1.0 forbids: the C0 controls but tab, newline and
// carriage return, lone surrogates, and U+FFFE / U+FFFF (§6.4).
const XML_FORBIDDEN = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

/**
 * Text for an element's content: colour codes and forbidden characters
 * removed, then escaped. Colour codes go first, since removing the forbidden
 * ESC alone would leave the `[31m` behind.
 */
function text(value: string): string {
  return stripAnsi(value)
    .replace(XML_FORBIDDEN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Text for an attribute value. Tab, newline and carriage return are written as
 * character references, because a parser turns them into spaces otherwise.
 */
function attr(value: string): string {
  return text(value)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}
